import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/client";
import { config } from "./config.js";
import { readSealedJson } from "./vault.js";
import { openInstamart } from "./instamart-client.js";

export const INSTAMART_TOOLS=['get_addresses','search_products','get_cart','update_cart','get_payment_options','checkout','check_payment_status','confirm_order','track_order'] as const;
export type InstamartTool=typeof INSTAMART_TOOLS[number];
export type InstamartCall=(name:InstamartTool,args:Record<string,unknown>)=>Promise<unknown>;
export const schemaHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const Settings=z.object({addressId:z.string().min(1).max(64),label:z.string().min(1).max(40),address:z.string().min(1).max(1500),lat:z.number().optional(),lng:z.number().optional(),timezone:z.string(),schemas:z.record(z.string(),z.string()),checkoutEnabled:z.boolean(),cartAddressHash:z.string(),cartAddressId:z.string().optional()});
export type InstamartSettings=z.infer<typeof Settings>;
export const instamartSettings=()=>Settings.parse(readSealedJson(path.join(config.dataDir,'instamart-settings.json'),{}));
export const instamartEnabled=()=>config.shoppingProvider==='instamart';
let connection:Promise<Client>|undefined;
async function client(){
 if(!connection)connection=(async()=>{
  const c=await openInstamart();
  try{const {tools}=await c.listTools();const known=instamartSettings().schemas;
   for(const name of INSTAMART_TOOLS){const t=tools.find(t=>t.name===name);if(!t||known[name]!==schemaHash(t.inputSchema))throw new Error('Instamart tool schemas changed; reconnect and review before shopping.');}
   c.onclose=()=>{connection=undefined;};return c;
  }catch(error){await c.close();throw error;}
 })().catch(error=>{connection=undefined;throw error;});
 return connection;
}
/** No generic MCP tool is exposed to the model. Exact known operations only. Never retry writes. */
export const callInstamart:InstamartCall=async(name,args)=>{
 if(!INSTAMART_TOOLS.includes(name))throw new Error('Unsupported shopping operation.');
 const c=await client();let result;
 try{result=await c.callTool({name,arguments:args},{timeout:20_000});}
 catch{throw new Error('Instamart did not confirm the operation.');}
 if(result.isError)throw new Error('Instamart refused the operation.');
 let data:unknown=result.structuredContent;
 if(!data){for(const part of result.content??[])if(part.type==='text'){try{data=JSON.parse(part.text);break;}catch{}}}
 if(!data||typeof data!=='object')throw new Error('Instamart returned an unsupported response.');
 const envelope=data as Record<string,unknown>;
 if(envelope.success===false)throw new Error('Instamart refused the operation.');
 return envelope.success===true?envelope.data:data;
};
export function rupeesToPaise(value:unknown):number{
 const text=String(value??'').trim().replace(/^₹\s*/,'').replace(/,/g,'');
 if(!/^\d+(?:\.\d{1,2})?$/.test(text))throw new Error('Unclear price returned by Instamart.');
 const amount=Math.round(Number(text)*100);
 if(!Number.isSafeInteger(amount)||amount<0||amount>10_000_000)throw new Error('Invalid Instamart amount.');return amount;
}
export const Product=z.object({spinId:z.string().min(1),skuId:z.string().min(1),name:z.string().min(1).max(160),pack:z.string().max(100),price:z.number().int().nonnegative(),maxQuantity:z.number().int().positive().max(1000)});
export type Product=z.infer<typeof Product>;
const Variation=z.object({spinId:z.string(),skuId:z.string(),displayName:z.string(),quantityDescription:z.string(),price:z.object({offerPrice:z.number()}),isInStockAndAvailable:z.boolean(),maxQuantity:z.number().int().nonnegative().optional()});
export function productsFrom(data:unknown):Product[]{
 const result=z.object({products:z.array(z.object({variations:z.array(Variation)}))}).parse(data);
 return result.products.flatMap(p=>p.variations.filter(v=>v.isInStockAndAvailable&&(v.maxQuantity??1)>0).map(v=>Product.parse({spinId:v.spinId,skuId:v.skuId,name:v.displayName.slice(0,160),pack:v.quantityDescription.slice(0,100),price:rupeesToPaise(v.price.offerPrice),maxQuantity:Math.min(v.maxQuantity??100,100)}))).slice(0,12);
}
const CartItem=z.object({spinId:z.string(),skuId:z.string(),quantity:z.number().int().positive(),storeId:z.union([z.string(),z.number()]),itemName:z.string(),itemVariant:z.string(),isInStockAndAvailable:z.boolean(),discountedFinalPrice:z.number(),maxQuantity:z.number().int().positive().optional()});
export function cartFrom(data:unknown,addressId:string,expectedAddressHash?:string,expectedCartAddressId=addressId){
 const c=z.object({selectedAddress:z.string().optional(),selectedAddressDetails:z.object({id:z.string()}).passthrough().optional(),cartTotalAmount:z.string(),items:z.array(CartItem),billBreakdown:z.object({lineItems:z.array(z.object({label:z.string(),value:z.string()})),toPay:z.object({value:z.string()})}),cartId:z.string().optional()}).parse(data);
 if(c.items.length&&c.selectedAddressDetails?.id!==expectedCartAddressId)throw new Error('The remote cart delivery address changed. Ask for a fresh basket review.');
 if(c.items.length&&expectedAddressHash&&schemaHash(c.selectedAddressDetails)!==expectedAddressHash)throw new Error('The saved delivery address details changed. The account holder needs to review the delivery address again before checkout.');
 const total=rupeesToPaise(c.billBreakdown.toPay.value);if(total!==rupeesToPaise(c.cartTotalAmount))throw new Error('Instamart returned inconsistent totals.');
 if(c.items.some(i=>!i.isInStockAndAvailable||i.maxQuantity!==undefined&&i.quantity>i.maxQuantity))throw new Error('A basket item is unavailable or exceeds its quantity limit.');
 if(new Set(c.items.map(i=>String(i.storeId))).size>1)throw new Error('V1 supports a single-store checkout. Split this basket before ordering.');
 return {items:c.items,total,bill:c.billBreakdown.lineItems,cartId:c.cartId??null,addressId,
  identity:schemaHash({addressId,cartId:c.cartId??null,items:c.items.map(i=>({spinId:i.spinId,skuId:i.skuId,quantity:i.quantity})).sort((a,b)=>a.skuId.localeCompare(b.skuId))}),
  fingerprint:schemaHash({addressId,addressDetails:c.selectedAddressDetails,cartId:c.cartId??null,items:c.items.map(i=>({spinId:i.spinId,skuId:i.skuId,quantity:i.quantity,price:i.discountedFinalPrice,storeId:i.storeId})).sort((a,b)=>a.skuId.localeCompare(b.skuId)),total,bill:c.billBreakdown})};
}
export type Cart=ReturnType<typeof cartFrom>;
export function paymentFrom(data:unknown,method:'cod'|'gpay'){
 const p=z.object({cod:z.object({available:z.boolean(),id:z.string()}).optional(),platforms:z.object({mobile:z.object({methods:z.array(z.object({id:z.string(),displayName:z.string(),kind:z.string().optional()}))}).optional()}).optional(),allMethods:z.array(z.object({id:z.string(),enabled:z.boolean().optional()}))}).parse(data);
 if(method==='cod'&&p.cod?.available&&p.allMethods.some(m=>m.id===p.cod!.id&&m.enabled!==false))return {paymentMethod:'Cash',label:'Pay on delivery',intentApp:undefined};
 const gpay=p.platforms?.mobile?.methods.find(m=>m.displayName.toLowerCase()==='google pay'&&m.kind==='intent');
 if(method==='gpay'&&gpay&&p.allMethods.some(m=>m.id===gpay.id&&m.enabled!==false))return {paymentMethod:'UPI',label:'Google Pay',intentApp:gpay.id};
 throw new Error(`Instamart is not offering ${method==='cod'?'pay on delivery':'Google Pay'} for this cart. Choose another available method.`);
}
