import type OpenAI from "openai";
import { Product, instamartEnabled } from "./instamart.js";
import { z } from "zod";
import { config, getUsers } from "./config.js";
import { chatFile } from "./store.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

const Item=z.object({product:Product.optional(),id:z.number().int().positive(),request:z.string().min(1).max(160),quantity:z.number().int().min(1).max(100),by:z.string()});
const Basket=z.object({revision:z.number().int().nonnegative(),next:z.number().int().positive(),items:z.array(Item).max(60)});
type Basket=z.infer<typeof Basket>;
const Update=z.object({action:z.enum(['add','set_quantity','remove','clear']),request:z.string().trim().max(160).nullable(),item:z.number().int().positive().nullable(),quantity:z.number().int().min(1).max(100).nullable()}).strict();
export const householdShoppingEnabled=()=>config.zeptoEnabled&&!!config.zeptoGroupId&&!!config.zeptoAccountUserId;
export function householdShoppingAccess(user:string,group?:string){
 return householdShoppingEnabled()&&group===config.zeptoGroupId&&getUsers().some(u=>u.id===user)&&getUsers().some(u=>u.id===config.zeptoAccountUserId);
}
const basketFile=()=>chatFile(config.zeptoGroupId!,"household-basket.json");
export function householdBasket():Basket{return Basket.parse(readSealedJson(basketFile(),{revision:0,next:1,items:[]}));}
function money(value:number|undefined){return value&&Number.isFinite(value)&&value>0?`₹${value}`:'not set';}
export function saveHouseholdBasket(basket:Basket){writeSealedJson(basketFile(),Basket.parse(basket));}
export function householdShopStatus(){
 if(instamartEnabled())return `Instamart household shopping is connected. Limits: ${money(config.zeptoOrderLimit)} per order, ${money(config.zeptoDailyLimit)} per day. Registered household members can prepare a basket and approve its exact numbered bill in this group. Use Google Pay or pay on delivery when offered. No purchase happens from adding items.`;
 return `Household shopping basket: on. Limits: ${money(config.zeptoOrderLimit)} per order, ${money(config.zeptoDailyLimit)} per day. Registered household members may prepare the basket and, once checkout is enabled, approve an exact numbered checkout in this group.\nLive Zepto shopping is not enabled: account connection and checkout tool verification are still required. Nothing can be ordered or charged through this feature yet.`;
}
export function showHouseholdBasket(basket:Basket){
 return `Household basket${basket.items.length?'\n'+basket.items.map(i=>`B${i.id}: ${i.quantity} × ${i.product?i.product.name+" ("+i.product.pack+")":i.request}`).join('\n'):': empty.'}\n${instamartEnabled()?"Selected packs come from live Instamart search; stock, fees and total are rechecked before checkout.":"Draft requests only: products, pack sizes, stock, prices and the payable total have not been checked with Zepto."} No order placed.`;
}
export function controlHouseholdBasket(name:string,args:Record<string,unknown>,user:string,group?:string):string{
 if(!householdShoppingAccess(user,group))return 'Household shopping is available only to registered people in the configured household group.';
 if(name==='household_shop_status')return householdShopStatus();
 const basket=householdBasket();
 if(name==='household_basket_show')return showHouseholdBasket(basket);
 if(name==='household_basket_update'&&readSealedJson<{orders?:{state:string}[]}>(chatFile(config.zeptoGroupId!,"household-checkouts.json"),{}).orders?.some(o=>['submitting','unknown','payment_pending'].includes(o.state)))return 'An order or payment is still unsettled. Check its status before changing the basket.';
 if(name!=='household_basket_update')return 'Unknown household shopping operation.';
 const parsed=Update.safeParse(args);if(!parsed.success)return 'Invalid basket change. Give a request and quantity to add, or an existing B-number to edit/remove.';
 const {action,request,item,quantity}=parsed.data;
 switch(action){
  case 'add':{
   if(!request||!quantity)return 'Adding needs a nonempty shopping request and quantity.';
   if(basket.items.length>=60)return 'The basket already has 60 lines. Remove something before adding more.';
   // Repeated mentions are additive; pack/brand differences stay separate, not guessed substitutions.
   const same=basket.items.find(i=>i.request.toLowerCase()===request.toLowerCase());
   if(same){if(same.quantity+quantity>Math.min(100,same.product?.maxQuantity??100))return 'That would exceed the selected product quantity limit.';same.quantity+=quantity;}
   else basket.items.push({id:basket.next++,request,quantity,by:user});
   break;
  }
  case 'set_quantity':{
   const line=basket.items.find(i=>i.id===item);if(!line||!quantity)return 'Choose an existing B-number and the intended quantity.';if(line.product&&quantity>line.product.maxQuantity)return 'That exceeds the selected product quantity limit.';line.quantity=quantity;break;
  }
  case 'remove':{
   if(!basket.items.some(i=>i.id===item))return 'That basket line does not exist.';basket.items=basket.items.filter(i=>i.id!==item);break;
  }
  case 'clear':basket.items=[];break;
 }
 basket.revision++;saveHouseholdBasket(basket);return showHouseholdBasket(basket);
}
const fn=(name:string,description:string,properties:Record<string,unknown>):OpenAI.Responses.FunctionTool=>({type:'function',name,description,strict:true,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});
export const householdShoppingTools=[
 fn('household_shop_status','Read household shopping setup and limits. No purchase is made.',{}),
 fn('household_basket_show','Show the household shopping basket. Draft requests, not a live Zepto bill.',{}),
 fn('household_basket_update','Add an explicitly requested item to the shared household basket, set an existing line quantity, remove a line or clear it when asked. This cannot order anything. Use null for unused fields. Preserve brand/pack details from the request.',{
  action:{type:'string',enum:['add','set_quantity','remove','clear']},request:{type:['string','null']},item:{type:['integer','null'],description:'Existing B-number, e.g. 2 for B2.'},quantity:{type:['integer','null'],minimum:1,maximum:100}
 })
];

export const liveHouseholdTools=[
 fn('household_shop_search','Search live Instamart products for the configured household Flat address. Returns P-numbers. Ask the person to pick the exact P-number before selecting a basket product.',{query:{type:'string'}}),
 fn('household_basket_select','Resolve one existing basket B-number to a product P-number explicitly selected in the human message. Never silently choose substitutes.',{item:{type:'integer',minimum:1},product:{type:'string'}}),
 fn('household_checkout_preview','Build the selected household basket in Instamart and send its exact bill for a later numbered group approval. This does not place an order. Never use the browser for checkout.',{payment:{type:'string',enum:['cod','gpay']}}),
 fn('household_order_status','Show the last recorded state of household orders only. No access to the account holder’s personal order history.',{})
];
