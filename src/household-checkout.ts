import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config, getUsers } from './config.js';
import { chatFile } from './store.js';
import { readSealedJson, writeSealedJson } from './vault.js';
import { householdShoppingAccess, householdBasket, saveHouseholdBasket } from './household-shopping.js';
import { callInstamart, instamartEnabled, instamartSettings, productsFrom, cartFrom, paymentFrom, rupeesToPaise, schemaHash, type InstamartCall, type InstamartSettings, type Product } from './instamart.js';

const boot=randomUUID();
type State='awaiting'|'expired'|'submitting'|'unknown'|'payment_pending'|'placed'|'failed';
type Order={id:string;boot:string;revision:number;created:number;source:string;state:State;amount:number;day:string;fingerprint:string;method:'cod'|'gpay';payment:{paymentMethod:string;label:string;intentApp?:string};
 actor?:string;requestId?:string;orderId?:string;paasId?:string;transactionId?:string;bridge?:string;until?:number;nextPoll?:number;interval?:number;notified?:boolean};
type Ledger={next:number;orders:Order[];ownedCart?:string};
type Catalog={next:number;items:{ref:string;at:number;product:Product}[]};
const emptyLedger=():Ledger=>({next:1,orders:[]});
const pending=(o:Order)=>['submitting','unknown','payment_pending'].includes(o.state);
export const formatMoney=(paise:number)=>`₹${(paise/100).toFixed(2)}`;
export const shoppingApprovalCandidate=(text:string)=>/\b(?:yes|confirm|cancel)\s+z\d+\b/i.test(text);
export const shoppingApproval=(text:string)=>text.trim().match(/^(yes|confirm|cancel)\s+(Z[1-9]\d*)[.!]?$/i);
function file(name:string){return chatFile(config.zeptoGroupId!,name+'.json');}
export function shoppingDay(at:number,zone:string){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));}
export function shoppingBudget(orders:Order[],amount:number,day:string){
 const orderLimit=config.zeptoOrderLimit,dailyLimit=config.zeptoDailyLimit;
 if(!orderLimit||!dailyLimit||!Number.isFinite(orderLimit)||!Number.isFinite(dailyLimit)||orderLimit<=0||dailyLimit<=0)throw new Error('Household spending limits are not configured.');
 if(amount>Math.floor(orderLimit*100))throw new Error(`This bill exceeds the ${formatMoney(Math.floor(orderLimit*100))} per-order limit.`);
 const used=orders.filter(o=>pending(o)||o.state==='placed'&&o.day===day).reduce((sum,o)=>sum+o.amount,0);
 if(used+amount>Math.floor(dailyLimit*100))throw new Error(`This would exceed today's ${formatMoney(Math.floor(dailyLimit*100))} household limit. Existing orders and unsettled payments count towards it.`);
}

/** One account-wide queue covers group quotes, approvals and payment polling. No nested acquisition. */
export class HouseholdCheckout {
 private tail:Promise<unknown>=Promise.resolve();private waiting=0;
 constructor(private call:InstamartCall=callInstamart,private settings:()=>InstamartSettings=instamartSettings,private now=Date.now){}
 private locked<T>(fn:()=>Promise<T>):Promise<T>{
  if(this.waiting>=6)return Promise.reject(new Error('Shopping is busy. Try again shortly.'));
  this.waiting++;const result=this.tail.catch(()=>{}).then(fn);this.tail=result.finally(()=>{this.waiting--;});void this.tail.catch(()=>{});return result;
 }
 private ledger(){const ledger=readSealedJson<Ledger>(file('household-checkouts'),emptyLedger());for(const order of ledger.orders)if(order.state==='submitting'&&order.boot!==boot)order.state='unknown';return ledger;}
 private save(ledger:Ledger){writeSealedJson(file('household-checkouts'),ledger);}
 private access(user:string,group?:string){if(!instamartEnabled()||!householdShoppingAccess(user,group))throw new Error('Instamart is available only to registered people in the household group.');}
 private noPending(l:Ledger){if(l.orders.some(pending))throw new Error('An order or payment is still unsettled. Check its status before preparing another checkout.');}
 async search(user:string,group:string,query:string){return this.locked(async()=>{
  this.access(user,group);if(!query.trim()||query.length>160)throw new Error('Give a short product search.');
  const found=productsFrom(await this.call('search_products',{addressId:this.settings().addressId,query:query.trim()}));
  const catalog=readSealedJson<Catalog>(file('household-catalog'),{next:1,items:[]});catalog.items=catalog.items.filter(i=>this.now()-i.at<15*60_000).slice(-100);
  const results=found.map(product=>{const item={ref:'P'+catalog.next++,at:this.now(),product};catalog.items.push(item);return item;});
  writeSealedJson(file('household-catalog'),catalog);
  return results.length?results.map(i=>`${i.ref}: ${i.product.name} · ${i.product.pack} · ${formatMoney(i.product.price)} per pack`).join('\n')+'\nLive search results, not a final bill. Choose a specific pack before selecting it for a basket line.':'Instamart returned no available matches. This is not proof that the item is unavailable everywhere.';
 });}
 select(user:string,group:string,item:number,ref:string,said:string){
  this.access(user,group);this.noPending(this.ledger());
  // A model cannot silently choose a substitute. The human must identify the returned option.
  if(!new RegExp(`\\b${ref.replace(/[^a-z0-9]/gi,'')}\\b`,'i').test(said))throw new Error('Ask which P-number they want; their own message must identify the product option.');
  const c=readSealedJson<Catalog>(file('household-catalog'),{next:1,items:[]});const choice=c.items.find(i=>i.ref.toUpperCase()===ref.toUpperCase()&&this.now()-i.at<15*60_000);
  const basket=householdBasket(),line=basket.items.find(i=>i.id===item);
  if(!choice||!line)throw new Error('That product option or basket line expired. Search again.');
  if(line.quantity>choice.product.maxQuantity)throw new Error('Requested quantity exceeds this product limit.');
  line.product=choice.product;basket.revision++;saveHouseholdBasket(basket);
  return `Selected ${choice.ref}: ${choice.product.name} (${choice.product.pack}) for B${line.id}, quantity ${line.quantity}. No order placed.`;
 }
 async preview(user:string,group:string,method:'cod'|'gpay',source:string){return this.locked(async()=>{
  this.access(user,group);const s=this.settings();if(!s.checkoutEnabled)throw new Error('Checkout is not enabled for this installation.');
  const l=this.ledger();this.noPending(l);const basket=householdBasket();
  if(!basket.items.length||basket.items.some(i=>!i.product))throw new Error('Every basket line needs a selected live product before checkout. Search and choose the P-number first.');
  const current=cartFrom(await this.call('get_cart',{}),s.addressId,s.cartAddressHash,s.cartAddressId);
  if(current.items.length&&current.identity!==l.ownedCart)throw new Error('The Swiggy cart contains items outside this household basket, or changed in the app. Review/clear it in Swiggy before replacing it. Nothing was overwritten.');
  const items=basket.items.map(i=>({spinId:i.product!.spinId,skuId:i.product!.skuId,quantity:i.quantity}));
  if(new Set(items.map(i=>i.skuId)).size!==items.length)throw new Error('The same SKU appears on multiple basket lines. Combine those lines before checkout.');
  await this.call('update_cart',{selectedAddressId:s.addressId,items});
  const cart=cartFrom(await this.call('get_cart',{}),s.addressId,s.cartAddressHash,s.cartAddressId);
  const actual=cart.items.map(i=>`${i.spinId}:${i.skuId}:${i.quantity}`).sort();
  if(JSON.stringify(actual)!==JSON.stringify(items.map(i=>`${i.spinId}:${i.skuId}:${i.quantity}`).sort()))throw new Error('Instamart changed the requested items or quantities. No checkout prepared; review the remote cart.');
  l.ownedCart=cart.identity;this.save(l);
  const payment=paymentFrom(await this.call('get_payment_options',{}),method);
  const day=shoppingDay(this.now(),s.timezone);shoppingBudget(l.orders,cart.total,day);
  if(householdBasket().revision!==basket.revision)throw new Error('The basket changed while the bill was being fetched. Prepare a new checkout.');
  for(const old of l.orders)if(old.state==='awaiting')old.state='expired';
  l.orders=l.orders.filter(o=>pending(o)||this.now()-o.created<30*86400_000);
  if(l.orders.length>=200)throw new Error('Household order history needs maintenance before another checkout.');
  const order:Order={id:'Z'+l.next++,boot,revision:basket.revision,created:this.now(),source,state:'awaiting',amount:cart.total,day,fingerprint:cart.fingerprint,method,payment};l.orders.push(order);this.save(l);
  return `${order.id} · Instamart checkout preview\n${cart.items.map(i=>`${i.quantity} × ${i.itemName} (${i.itemVariant})`).join('\n')}\n\n${cart.bill.map(b=>`${b.label}: ${b.value}`).join('\n')}\nTotal payable: ${formatMoney(cart.total)}\nDelivery: ${s.label}\nPayment: ${payment.label}\n\nAny registered household member can reply “${config.name}, yes ${order.id}” in this group within 5 minutes to ${method==='cod'?'place this order for payment on delivery':'create this checkout and receive its Google Pay payment link privately'}. Changes invalidate this bill. Nothing has been ordered yet.`;
 });}
 async approve(user:string,group:string,words:string,input:{plain:boolean;forwarded:boolean;audio:boolean;at:number;id:string;allowed:()=>Promise<boolean>}):Promise<{text:string;privateText?:string}>{return this.locked(async()=>{
  this.access(user,group);const match=shoppingApproval(words);if(!match)throw new Error('Use only “yes Z1” for the exact current bill, or “cancel Z1”. Changes need a new preview.');
  if(!input.plain||input.forwarded||input.audio||!input.id||!Number.isFinite(input.at))throw new Error('Checkout approval requires a fresh typed message, not a voice note, caption or forwarded message.');
  const l=this.ledger(),o=l.orders.find(o=>o.id===match[2].toUpperCase());if(!o)throw new Error('That checkout reference does not exist.');
  if(match[1].toLowerCase()==='cancel'){if(o.state!=='awaiting')throw new Error('This checkout is already submitted or closed. Cancellation must be handled in Swiggy.');o.state='expired';this.save(l);return {text:`${o.id} cancelled before ordering. The basket is kept.`};}
  if(o.state!=='awaiting')return {text:`${o.id}: ${o.state.replaceAll('_',' ')}. This approval will not place another order.`};
  if(o.boot!==boot||this.now()-o.created>300000||input.at<=o.created||input.at>this.now()+5000||input.id===o.source){o.state='expired';this.save(l);throw new Error('That checkout is expired or this is not a later approval. Ask for a fresh bill.');}
  this.noPending(l);const s=this.settings();if(!s.checkoutEnabled)throw new Error('Checkout is disabled.');
  if(householdBasket().revision!==o.revision)throw new Error('The basket changed. Ask for a fresh checkout preview.');
  const cart=cartFrom(await this.call('get_cart',{}),s.addressId,s.cartAddressHash,s.cartAddressId),payment=paymentFrom(await this.call('get_payment_options',{}),o.method);
  const lastCart=cartFrom(await this.call('get_cart',{}),s.addressId,s.cartAddressHash,s.cartAddressId);
  if(cart.fingerprint!==o.fingerprint||lastCart.fingerprint!==o.fingerprint||schemaHash(payment)!==schemaHash(o.payment))throw new Error('The live bill or payment method changed. Ask for a fresh checkout preview.');
  if(!await input.allowed()||!householdShoppingAccess(user,group)||this.now()-o.created>300000||householdBasket().revision!==o.revision)throw new Error('Approval access or the basket changed. Nothing ordered.');
  o.day=shoppingDay(this.now(),s.timezone);shoppingBudget(l.orders,o.amount,o.day);
  o.state='submitting';o.actor=user;o.requestId=input.id;this.save(l);
  let result:unknown;
  try{result=await this.call('checkout',{addressId:s.addressId,paymentMethod:o.payment.paymentMethod,...(o.payment.intentApp?{intentApp:o.payment.intentApp}:{})});}
  catch{o.state='unknown';this.save(l);return {text:`${o.id}: Instamart did not confirm the result. I will not retry or place another order. Check the Swiggy app; the budget remains reserved until this is resolved.`};}
  if(!result||typeof result!=='object'){o.state='unknown';this.save(l);return {text:`${o.id}: checkout returned an unreadable result. Check Swiggy before retrying; the budget remains reserved.`};}
  const r=result as Record<string,unknown>;
  const returnedTotal=r.cartTotal??r.totalAmount;
  if(returnedTotal!==undefined){let matches=false;try{matches=rupeesToPaise(returnedTotal)===o.amount;}catch{}if(!matches){o.state='unknown';this.save(l);return {text:`${o.id}: checkout returned a different or unclear amount. Check Swiggy; no payment link or retry will be sent.`};}}
  o.orderId=typeof r.orderId==='string'?r.orderId:undefined;
  if(r.status==='PENDING_PAYMENT'&&o.method==='gpay'&&o.orderId&&typeof r.paasId==='string'){
   o.state='payment_pending';o.paasId=r.paasId;o.transactionId=typeof r.transactionId==='string'?r.transactionId:undefined;
   if(typeof r.cartTotal==='number'&&rupeesToPaise(r.cartTotal)!==o.amount){o.state='unknown';this.save(l);return {text:`${o.id}: checkout returned a different amount. Stop and check the Swiggy app; I will not send a payment link or retry.`};}
   if(typeof r.bridgeUrl==='string'){try{const u=new URL(r.bridgeUrl);if(u.protocol==='https:'&&u.hostname==='mcp.swiggy.com'&&!u.username&&!u.password&&(!u.port||u.port==='443'))o.bridge=u.href;}catch{}}
   o.interval=Math.max(10000,Math.min(Number(r.pollingIntervalInMs)||15000,60000));o.nextPoll=this.now()+o.interval;o.until=this.now()+Math.min(Math.max(Number(r.maxTimeToPollForInMs)||300000,30000),600000);this.save(l);
   return {text:`${o.id}: payment pending, ${formatMoney(o.amount)} via Google Pay. ${o.bridge?'I’m sending the provider payment link to the approver privately.':'No supported payment link was returned; check the Swiggy app.'} The order is not confirmed yet.`,privateText:o.bridge?`${o.id} · Pay ${formatMoney(o.amount)} for the ${s.label} household order. Open this official Swiggy payment page and choose Google Pay if prompted:\n${o.bridge}\nPayment and order confirmation are still pending.`:undefined};
  }
  if(o.orderId&&['CONFIRMED','PLACED','SUCCESS','DELIVERED'].includes(String(r.status).toUpperCase())){
   o.state='placed';o.day=shoppingDay(this.now(),s.timezone);this.save(l);this.clearApproved(o);return {text:`${o.id}: Instamart order placed successfully. Order ${o.orderId}, ${formatMoney(o.amount)}, delivery to ${s.label}, ${o.payment.label}.`};
  }
  o.state='unknown';this.save(l);return {text:`${o.id}: checkout returned an unrecognized result. Check the Swiggy app before trying again. I will not retry; the budget remains reserved.`};
 });}
 private clearApproved(o:Order){const basket=householdBasket();if(basket.revision===o.revision){basket.items=[];basket.revision++;saveHouseholdBasket(basket);}}
 async status(user:string,group:string){return this.locked(async()=>{
  this.access(user,group);const l=this.ledger(),orders=l.orders.slice(-5);if(!orders.length)return 'No household orders have been submitted.';
  return orders.map(o=>`${o.id}: ${o.state.replaceAll('_',' ')} · ${formatMoney(o.amount)}${o.orderId?' · order '+o.orderId:''}`).join('\n');
 });}
 async poll():Promise<{id:string;group:string;actor?:string;text:string}[]>{return this.locked(async()=>{
  if(!instamartEnabled()||!config.zeptoGroupId||!getUsers().some(u=>u.id===config.zeptoAccountUserId))return [];
  const l=this.ledger(),updates:{id:string;group:string;actor?:string;text:string}[]=[];
  for(const o of l.orders.filter(o=>o.state==='payment_pending'&&(o.nextPoll??0)<=this.now()).slice(0,1)){
   if(!o.paasId||!o.orderId){o.state='unknown';this.save(l);continue;}
   if(this.now()>(o.until??0)){o.state='unknown';this.save(l);updates.push({id:o.id,group:config.zeptoGroupId,text:`${o.id}: payment confirmation timed out. Check Swiggy before retrying; I haven’t placed another order.`});continue;}
   o.nextPoll=this.now()+(o.interval??15000);this.save(l);
   let result:unknown;try{result=await this.call('check_payment_status',{paasId:o.paasId,orderId:o.orderId});}catch{continue;}
   const r=result as Record<string,unknown>,status=String(r.status??'').toUpperCase();
   if(['SUCCESS','PAID'].includes(status)){
    o.state='submitting';this.save(l);
    let confirmation:unknown;try{confirmation=await this.call('confirm_order',{orderId:o.orderId,paasId:o.paasId,...(o.transactionId?{transactionId:o.transactionId}:{})});}catch{o.state='unknown';this.save(l);updates.push({id:o.id,group:config.zeptoGroupId,text:`${o.id}: payment succeeded, but final order confirmation is uncertain. Check Swiggy; no new checkout will be attempted.`});continue;}
    const final=(confirmation&&typeof confirmation==='object'?confirmation:{}) as Record<string,unknown>;
    if(!['CONFIRMED','PLACED','SUCCESS','DELIVERED'].includes(String(final.status??'').toUpperCase())){o.state='unknown';this.save(l);updates.push({id:o.id,group:config.zeptoGroupId,text:`${o.id}: payment succeeded; the final order result needs checking in Swiggy.`});continue;}
    o.state='placed';o.day=shoppingDay(this.now(),this.settings().timezone);this.save(l);this.clearApproved(o);
    updates.push({id:o.id,group:config.zeptoGroupId,text:`${o.id}: Instamart order placed successfully. Payment confirmed, ${formatMoney(o.amount)}. Order ${o.orderId}, delivery to ${this.settings().label}.`});
   }else if(['FAILED','REFUND-INITIATED','REFUND_INITIATED'].includes(status)){
    // A late payment/refund can still affect balances: never release the reserve on an ambiguous provider result.
    o.state='unknown';this.save(l);updates.push({id:o.id,group:config.zeptoGroupId,text:`${o.id}: payment reported ${status.toLowerCase().replaceAll('_',' ')}. Check Swiggy before retrying; no new payment was requested.`});
   }
  }
  return updates;
 });}
 async reconcile(user:string,group:string,id:string){return this.locked(async()=>{
  this.access(user,group);if(user!==config.zeptoAccountUserId)throw new Error('Only the linked account holder can resolve an uncertain checkout after checking Swiggy.');
  const l=this.ledger(),o=l.orders.find(o=>o.id===id.toUpperCase());if(!o||!['unknown','submitting'].includes(o.state))throw new Error('There is no uncertain checkout with that reference.');
  o.state='failed';this.save(l);return `${o.id} marked not placed, based on the account holder’s explicit check in Swiggy. Its reserved budget is released. Review the basket and request a new bill before ordering.`;
 });}
}
export const householdCheckout=new HouseholdCheckout();
