import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client, StreamableHTTPClientTransport, auth, type OAuthClientProvider, type OAuthClientMetadata, type StoredOAuthClientInformation, type StoredOAuthTokens, type OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { config } from "./config.js";
import { readSealedJson, writeSealedJson } from "./vault.js";

export const ZEPTO_SERVER = "https://mcp.zepto.co.in/mcp";
type Credentials = {client?:StoredOAuthClientInformation;tokens?:StoredOAuthTokens;verifier?:string;state?:string;discovery?:OAuthDiscoveryState;redirect?:string};
export class ZeptoAuth implements OAuthClientProvider {
  constructor(private redirect?:string,private onRedirect?:(url:URL)=>void,private file=path.join(config.dataDir,"zepto-account.json")){}
  private read(){return readSealedJson<Credentials>(this.file,{});}
  private save(patch:Partial<Credentials>){writeSealedJson(this.file,{...this.read(),...patch});}
  get redirectUrl(){return this.redirect??this.read().redirect??"http://127.0.0.1/callback";}
  get clientMetadata():OAuthClientMetadata{return {client_name:"Inkling household shopping",redirect_uris:[String(this.redirectUrl)],grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:"none"};}
  state(){const state=randomBytes(24).toString("base64url");this.save({state,redirect:String(this.redirectUrl)});return state;}
  expectedState(){return this.read().state;}
  clientInformation(){return this.read().client;}
  saveClientInformation(client:StoredOAuthClientInformation){this.save({client});}
  tokens(){return this.read().tokens;}
  saveTokens(tokens:StoredOAuthTokens){this.save({tokens});}
  saveCodeVerifier(verifier:string){this.save({verifier});}
  codeVerifier(){const verifier=this.read().verifier;if(!verifier)throw new Error("Zepto sign-in needs to be restarted.");return verifier;}
  saveDiscoveryState(discovery:OAuthDiscoveryState){this.save({discovery});}
  discoveryState(){return this.read().discovery;}
  redirectToAuthorization(url:URL){if(!this.onRedirect)throw new Error("Zepto needs the account holder to sign in again.");this.onRedirect(url);}
  invalidateCredentials(scope:"all"|"client"|"tokens"|"verifier"|"discovery"){
    if(scope==="all")writeSealedJson(this.file,{});
    else this.save({[scope]:undefined});
  }
  finish(){this.save({state:undefined,verifier:undefined});}
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
