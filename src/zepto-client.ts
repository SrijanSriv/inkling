import path from "node:path";
import { Client, StreamableHTTPClientTransport, auth } from "@modelcontextprotocol/client";
import { config } from "./config.js";
import { ShoppingAuth } from "./shopping-auth.js";

export const ZEPTO_SERVER = "https://mcp.zepto.co.in/mcp";
export class ZeptoAuth extends ShoppingAuth {
  constructor(redirect?:string,onRedirect?:(url:URL)=>void,file=path.join(config.dataDir,"zepto-account.json")){super("Zepto",file,redirect,onRedirect);}
}

/** Never follow a discovery URL or redirect to an arbitrary MCP-supplied host. */
export const zeptoFetch:typeof fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.protocol!=="https:"||!["mcp.zepto.co.in","auth.zepto.co.in"].includes(url.hostname)||url.port&&!['443'].includes(url.port)||url.username||url.password)throw new Error("Unexpected Zepto service address.");
  return fetch(input,{...init,redirect:"error",signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(20_000)])});
};
export async function authorizeZepto(provider:ZeptoAuth,code?:string,iss?:string){
  return auth(provider,{serverUrl:ZEPTO_SERVER,resourceMetadataUrl:new URL("https://mcp.zepto.co.in/.well-known/oauth-protected-resource"),authorizationCode:code,iss,scope:"tools:read",fetchFn:zeptoFetch});
}
export async function openZepto(provider=new ZeptoAuth()){
  if(!provider.tokens())throw new Error("The household Zepto account is not connected yet.");
  const client=new Client({name:"inkling",version:"1"},{capabilities:{},listMaxPages:5});
  const transport=new StreamableHTTPClientTransport(new URL(ZEPTO_SERVER),{authProvider:provider,fetch:zeptoFetch});
  try{await client.connect(transport,{timeout:20_000});return client;}catch{await client.close().catch(()=>{});throw new Error("Zepto connection unavailable. The account may need reconnecting.");}
}
