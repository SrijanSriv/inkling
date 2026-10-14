import path from "node:path";
import { Client, StreamableHTTPClientTransport, auth } from "@modelcontextprotocol/client";
import { config } from "./config.js";
import { ShoppingAuth } from "./shopping-auth.js";

export const INSTAMART_SERVER = "https://mcp.swiggy.com/im";
export class InstamartAuth extends ShoppingAuth {
  constructor(redirect?:string,onRedirect?:(url:URL)=>void,file=path.join(config.dataDir,"instamart-account.json")){super("Instamart",file,redirect,onRedirect);}
}

/** Never follow a discovery URL or redirect to an arbitrary MCP-supplied host. */
export const instamartFetch:typeof fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.protocol!=="https:"||!["mcp.swiggy.com"].includes(url.hostname)||url.port&&!['443'].includes(url.port)||url.username||url.password)throw new Error("Unexpected Instamart service address.");
  return fetch(input,{...init,redirect:"error",signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(20_000)])});
};
export async function authorizeInstamart(provider:InstamartAuth,code?:string,iss?:string){
  return auth(provider,{serverUrl:INSTAMART_SERVER,resourceMetadataUrl:new URL("https://mcp.swiggy.com/.well-known/oauth-protected-resource"),authorizationCode:code,iss,scope:"mcp:tools",fetchFn:instamartFetch});
}
export async function openInstamart(provider=new InstamartAuth()){
  if(!provider.tokens())throw new Error("The household Instamart account is not connected yet.");
  const client=new Client({name:"inkling",version:"1"},{capabilities:{},listMaxPages:5});
  const transport=new StreamableHTTPClientTransport(new URL(INSTAMART_SERVER),{authProvider:provider,fetch:instamartFetch});
  try{await client.connect(transport,{timeout:20_000});return client;}catch{await client.close().catch(()=>{});throw new Error("Instamart connection unavailable. The account may need reconnecting.");}
}
