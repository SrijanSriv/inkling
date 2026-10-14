import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthClientMetadata, StoredOAuthClientInformation, StoredOAuthTokens, OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { readSealedJson, writeSealedJson } from "./vault.js";

type Credentials = {client?:StoredOAuthClientInformation;tokens?:StoredOAuthTokens;verifier?:string;state?:string;discovery?:OAuthDiscoveryState;redirect?:string};
export class ShoppingAuth implements OAuthClientProvider {
  constructor(private label:string,private file:string,private redirect?:string,private onRedirect?:(url:URL)=>void){}
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
  codeVerifier(){const verifier=this.read().verifier;if(!verifier)throw new Error(`${this.label} sign-in needs to be restarted.`);return verifier;}
  saveDiscoveryState(discovery:OAuthDiscoveryState){this.save({discovery});}
  discoveryState(){return this.read().discovery;}
  redirectToAuthorization(url:URL){if(!this.onRedirect)throw new Error(`${this.label} needs the account holder to sign in again.`);this.onRedirect(url);}
  invalidateCredentials(scope:"all"|"client"|"tokens"|"verifier"|"discovery"){
    if(scope==="all")writeSealedJson(this.file,{});
    else this.save({[scope]:undefined});
  }
  finish(){this.save({state:undefined,verifier:undefined});}
}

