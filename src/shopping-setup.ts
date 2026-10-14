/** One-time local-browser OAuth helper. No WhatsApp connection or order calls. */
import {createServer} from "node:http";
import {mkdirSync,existsSync,readFileSync,writeFileSync} from "node:fs";
import {homedir} from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
const which=process.argv[2]??"zepto";
if(!["zepto","instamart"].includes(which))throw new Error("Choose zepto or instamart.");
const label=which==="zepto"?"Zepto":"Instamart";
const root=path.join(homedir(),".config",`inkling-${which}-setup`);mkdirSync(root,{recursive:true,mode:0o700});
const key=path.join(root,"key");if(!existsSync(key))writeFileSync(key,randomBytes(32).toString('base64'),{mode:0o600});
process.env.INKLING_SECRET_KEY=readFileSync(key,"utf8").trim();
process.env.INKLING_DATA_DIR=root;
const adapter=which==="zepto"?await import("./zepto-client.js"):await import("./instamart-client.js");
const {Auth,authorize,open}= "ZeptoAuth" in adapter?{Auth:adapter.ZeptoAuth,authorize:adapter.authorizeZepto,open:adapter.openZepto}:{Auth:adapter.InstamartAuth,authorize:adapter.authorizeInstamart,open:adapter.openInstamart};
const redirect=process.env[which==="zepto"?"INKLING_ZEPTO_REDIRECT_URL":"INKLING_INSTAMART_REDIRECT_URL"]??`http://127.0.0.1:${which==="zepto"?8766:8767}/callback`;
const local=new URL(redirect);
if(local.protocol!=="http:"||local.hostname!=="127.0.0.1"||local.pathname!=="/callback"||local.search||local.hash)throw new Error("Use a local loopback callback.");
let authorizationUrl:URL|undefined,processing=false;
const provider=new Auth(redirect,url=>{authorizationUrl=url;console.log("Sign in at: "+url.href);});
const server=createServer((req,res)=>{
 const url=new URL(req.url??"/",redirect);
 const reply=(status:number,text:string)=>{res.writeHead(status,{"content-type":"text/plain; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer"});res.end(text);};
 if(url.pathname!=="/callback"||req.method!=="GET")return reply(404,"Not found");
 if(processing||!url.searchParams.get("code")||url.searchParams.get("state")!==provider.expectedState())return reply(403,"Invalid or expired sign-in.");
 processing=true;
 void(async()=>{
  try{
   await authorize(provider,url.searchParams.get("code")!,url.searchParams.get("iss")??undefined);
   provider.finish();const client=await open(provider);
   try{const tools=await client.listTools();writeFileSync(path.join(root,"tools.json"),JSON.stringify(tools,null,2),{mode:0o600});console.log("Connected. Tool names: "+tools.tools.map(t=>t.name).join(", "));}
   finally{await client.close();}
   reply(200,`${label} connection saved securely. You can close this page and return to Codex.`);server.close();
  }catch{reply(502,`${label} sign-in could not finish. Return to Codex; no order was placed.`);processing=false;}
 })();
});
server.requestTimeout=10000;server.headersTimeout=5000;
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(local.port||80),'127.0.0.1',resolve);});
const timeout=setTimeout(()=>{console.log("Sign-in window expired.");server.close();},30*60_000);timeout.unref();
try{await authorize(provider);if(!authorizationUrl){console.log("Existing connection is ready.");server.close();}}
catch(error){console.log(error instanceof Error?error.name+": "+error.message.replace(/https?:\/\/\S+/g,"[service URL]").slice(0,250):"Connection rejected");console.log(`${label} did not accept this connection setup. No order was placed.`);server.close();process.exitCode=1;}
