import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { config, getUsers } from "./config.js";
import { chatFile } from "./store.js";
import { readSealedJson, writeSealedJson } from "./vault.js";
import { requestMusic } from "./music-client.js";
import { log } from "./log.js";

const exec = promisify(execFile);
const MAX_AUDIO = 2_200_000;
const voices = new Set(["af_bella", "af_nicole", "am_eric", "hf_alpha"]);
type State = "off" | "ready" | "synthesizing" | "speaking" | "unavailable";
type Reason = "cancelled" | "speaker_unavailable" | "music_active" | "music_unavailable" | "unsupported_text" | "busy" | "timeout" | "recovery_required" | "synthesis_failed" | "invalid_audio" | "playback_failed" | "played";
class SpeechFailure extends Error { constructor(readonly reason: Reason) { super(reason); } }

/** Accept only a complete, bounded PCM WAV; return its audio without the container header. */
export function speechPcm(wav: Buffer): Buffer {
  const invalid = () => new SpeechFailure("invalid_audio");
  if(wav.length<44||wav.length>MAX_AUDIO||wav.toString("ascii",0,4)!=="RIFF"||wav.toString("ascii",8,12)!=="WAVE"
    ||wav.readUInt32LE(4)+8!==wav.length)throw invalid();
  let format=false,pcm:Buffer|undefined;
  for(let at=12;at+8<=wav.length;){
    const kind=wav.toString("ascii",at,at+4),size=wav.readUInt32LE(at+4),end=at+8+size;
    if(end>wav.length)throw invalid();
    if(kind==="fmt "){
      if(format||size<16||wav.readUInt16LE(at+8)!==1||wav.readUInt16LE(at+10)!==1||wav.readUInt32LE(at+12)!==24000
        ||wav.readUInt32LE(at+16)!==48000||wav.readUInt16LE(at+20)!==2||wav.readUInt16LE(at+22)!==16)throw invalid();
      format=true;
    }
    if(kind==="data"){if(pcm)throw invalid();pcm=wav.subarray(at+8,end);}
    at=end+(size%2);
    if(at===wav.length)break;
    if(at+8>wav.length)throw invalid();
  }
  if(!format||!pcm?.length||pcm.length%2||pcm.length>45*48000)throw invalid();
  return pcm;
}

export function speechText(text: string): string | undefined {
  // Preserve wording/numbers; complex content stays on WhatsApp rather than getting a model rewrite.
  if(!text.trim()||Array.from(text).length>800||/[`{}<>]|https?:\/\/|\bwww\.|\[.+\]\(/i.test(text))return;
  const plain=text.replace(/(^|\s)([*_~])([^\n*_~]+)\2(?=\s|$)/g,"$1$3").trim();
  if(/[*_~]/.test(plain)||(!config.micSpeechVoice.startsWith("h")&&/\p{Script=Devanagari}/u.test(plain)))return;
  return plain||undefined;
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  if(!config.whisperUrl||!config.whisperSecret)throw new SpeechFailure("synthesis_failed");
  const chunks:Buffer[]=[];
  try {
    const response=await fetch(new URL("/synthesize",config.whisperUrl),{method:"POST",
      headers:{authorization:`Bearer ${config.whisperSecret}`,"content-type":"application/json"},
      body:JSON.stringify({text,voice:config.micSpeechVoice}),signal:AbortSignal.timeout(12_000)});
    if(!response.ok){
      const reader=response.body?.getReader();let errorText="";
      try {if(reader){const {value}=await reader.read();if(value&&value.length<=1000)errorText=Buffer.from(value).toString();}}
      finally {await reader?.cancel().catch(()=>{});reader?.releaseLock();}
      throw new SpeechFailure(response.status===429?"busy":errorText.includes('"recovery_required"')?"recovery_required":"synthesis_failed");
    }
    if(response.headers.get("content-type")!=="audio/wav"||!response.body){await response.body?.cancel();throw new SpeechFailure("invalid_audio");}
    const reader=response.body.getReader();let size=0;
    try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;
      if(size>MAX_AUDIO)throw new SpeechFailure("invalid_audio");chunks.push(Buffer.from(value));}}
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
    const wav=Buffer.concat(chunks);try{speechPcm(wav);return wav;}catch(error){wav.fill(0);throw error;}
  } catch(error) {
    if(error instanceof SpeechFailure)throw error;
    throw new SpeechFailure(error instanceof Error&&error.name==="TimeoutError"?"timeout":"synthesis_failed");
  } finally {for(const chunk of chunks)chunk.fill(0);}
}

async function speakerReady(): Promise<void> {
  try {
    if(!config.micSpeechSink||config.micSpeechSink==="auto_null")throw new Error();
    const {stdout}=await exec("pw-dump",[],{timeout:1500,maxBuffer:4*1024*1024});
    const nodes=JSON.parse(stdout) as {info?:{props?:Record<string,unknown>;params?:{Props?:{mute?:boolean;channelVolumes?:number[]}[]}}}[];
    const node=nodes.find(n=>n.info?.props?.["node.name"]===config.micSpeechSink&&n.info?.props?.["media.class"]==="Audio/Sink");
    const props=node?.info?.params?.Props;
    if(!node||!props?.length||props.some(p=>p.mute===true)||!props.some(p=>p.channelVolumes?.some(v=>v>0)))throw new Error();
  } catch {throw new SpeechFailure("speaker_unavailable");}
}

async function musicQuiet(): Promise<void> {
  if(!config.musicSocket)return;
  try {
    const result=await requestMusic(config.musicSocket,{id:randomUUID(),action:"status"},1200);
    const playback=(result.data as {playback?:string})?.playback;
    if(!result.ok||!playback)throw new Error();
    if(["playing","buffering","loading"].includes(playback))throw new SpeechFailure("music_active");
  } catch(error) {throw error instanceof SpeechFailure?error:new SpeechFailure("music_unavailable");}
}

export function playSpeech(pcm: Buffer, signal: AbortSignal, started: ()=>void): Promise<void> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted)return reject(new SpeechFailure("cancelled"));
    const child=spawn("pw-play",["--target",config.micSpeechSink!,"--properties","{ node.dont-reconnect = true node.dont-fallback = true }",
      "--raw","--rate","24000","--channels","1","--format","s16","-"],{stdio:["pipe","ignore","ignore"]});
    let settled=false,kill:NodeJS.Timeout|undefined;
    const stop=()=>{child.kill("SIGTERM");kill??=setTimeout(()=>child.kill("SIGKILL"),1000);kill.unref();};
    const abort=()=>stop();signal.addEventListener("abort",abort,{once:true});
    const timeout=setTimeout(()=>{stop();},50_000);timeout.unref();
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timeout);clearTimeout(kill);signal.removeEventListener("abort",abort);error?reject(error):resolve();};
    child.once("error",()=>finish(new SpeechFailure("playback_failed")));
    child.once("spawn",()=>{if(signal.aborted)stop();else started();});
    child.stdin.on("error",()=>{stop();});
    child.once("close",code=>finish(signal.aborted?new SpeechFailure("cancelled"):code===0?undefined:new SpeechFailure("playback_failed")));
    child.stdin.end(pcm);
  });
}

export type RoomSpeechDependencies = {
  muted: ()=>boolean;
  ready?: ()=>Promise<void>;
  quiet?: ()=>Promise<void>;
  synthesize?: (text:string)=>Promise<Buffer>;
  play?: (pcm:Buffer,signal:AbortSignal,started:()=>void)=>Promise<void>;
};

/** One current physical turn; no pending audio survives restart and no speech backlog exists. */
export class RoomSpeech {
  private enabled=false;
  private state:State="off";
  private reason?:Reason;
  private turn?:{owner:string;id:string;used:boolean;at:number};
  private active?:AbortController;
  private working=false;
  constructor(private deps:RoomSpeechDependencies){
    const owner=getUsers().find(u=>u.owner);
    if(this.configured()&&owner)this.enabled=readSealedJson<{enabled:boolean}>(chatFile(owner.id,"mic-speech.json"),{enabled:false}).enabled===true;
    this.state=this.enabled?"ready":"off";
  }
  private configured(){return config.micSpeech&&config.micMuteSwitch&&config.micConversation&&!!config.micSpeechSink
    &&voices.has(config.micSpeechVoice)&&!!config.whisperUrl&&!!config.whisperSecret;}
  private owner(id:string){return getUsers().some(u=>u.id===id&&u.owner);}
  status(){return {state:this.state,reason:this.reason,detail:this.reason?.replaceAll("_"," ")};}
  command(owner:string,action:"on"|"off"|"status"):string {
    if(!this.owner(owner))throw new Error("Room speech controls are owner-only in private chat.");
    if(action==="status")return `Room speech: ${this.state}${this.reason?` (${this.reason.replaceAll("_"," ")})`:""}. ${this.configured()?"Physical mic replies only; WhatsApp text stays on.":"Installation is not configured."}`;
    if(action==="on"&&!this.configured())throw new Error("Configure the room speech gateway, voice and speaker first.");
    writeSealedJson(chatFile(owner,"mic-speech.json"),{enabled:action==="on"});
    this.enabled=action==="on";this.interrupt();
    return this.enabled?"Room speech is on for your physical mic replies. Answers will be audible in the room; WhatsApp text stays on.":"Room speech is off. Mic replies still go to WhatsApp.";
  }
  interrupt():void {this.turn=undefined;this.active?.abort();this.state=this.enabled?"ready":"off";this.reason="cancelled";}
  capture(owner:string,id:string,physical:boolean):void {
    this.interrupt();
    if(physical&&this.configured()&&this.enabled&&this.owner(owner))this.turn={owner,id,used:false,at:Date.now()};
  }
  async reply(owner:string,id:string,text:string,doneAt?:number):Promise<void> {
    const turn=this.turn;
    if(!turn||turn.used||turn.owner!==owner||turn.id!==id)return;
    turn.used=true;
    const valid=()=>this.turn===turn&&this.enabled&&this.configured()&&this.owner(owner)&&this.deps.muted()&&Date.now()-turn.at<120_000;
    if(!valid())return;
    const speech=speechText(text);
    if(!speech){this.state="unavailable";this.reason="unsupported_text";return;}
    if(this.working){this.state="unavailable";this.reason="busy";return;}
    this.working=true;const abort=new AbortController();this.active=abort;
    let wav:Buffer|undefined,watch:NodeJS.Timeout|undefined,checking=false;
    const started=Date.now();
    const ready=async()=>{await (this.deps.ready??speakerReady)();await (this.deps.quiet??musicQuiet)();};
    try {
      await ready();if(!valid())throw new SpeechFailure("cancelled");
      this.state="synthesizing";this.reason=undefined;
      const synthAt=Date.now();wav=await (this.deps.synthesize??synthesizeSpeech)(speech);
      log.info({id,synthesisMs:Date.now()-synthAt,bytes:wav.length},"room speech synthesized");
      const pcm=speechPcm(wav);await ready();if(!valid())throw new SpeechFailure("cancelled");
      // Recheck removal, mute/source state and sink availability during room playback too.
      watch=setInterval(()=>{if(checking)return;checking=true;
        void (async()=>{try {if(!valid())throw new SpeechFailure("cancelled");await ready();}
          catch {abort.abort();}finally{checking=false;}})();},1000);watch.unref();
      await (this.deps.play??playSpeech)(pcm,abort.signal,()=>{
        if(!valid()){abort.abort();return;}
        this.state="speaking";log.info({id,firstPlaybackMs:Date.now()-started,
          muteToPlaybackMs:doneAt===undefined?undefined:Math.max(0,Date.now()-doneAt)},"room speech playback started");
      });
      if(abort.signal.aborted)throw new SpeechFailure("cancelled");
      if(this.turn===turn){this.state=this.enabled?"ready":"off";this.reason="played";}
      log.info({id,totalMs:Date.now()-started},"room speech playback completed");
    } catch(error) {
      const reason=error instanceof SpeechFailure?error.reason:"playback_failed";
      if(this.turn===turn){this.state=this.enabled?(reason==="cancelled"?"ready":"unavailable"):"off";this.reason=reason;}
      log.info({id,reason},"room speech skipped or stopped");
    } finally {clearInterval(watch);wav?.fill(0);if(this.active===abort)this.active=undefined;this.working=false;}
  }
}
