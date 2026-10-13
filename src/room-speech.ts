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

/** Framed complete WAV chunks allow validation before any bytes reach the speaker. */
async function* readSpeechChunks(text:string,signal:AbortSignal):AsyncGenerator<Buffer> {
  const combined=AbortSignal.any([signal,AbortSignal.timeout(12_000)]);
  const response=await fetch(new URL("/synthesize/stream",config.whisperUrl!),{method:"POST",
    headers:{authorization:`Bearer ${config.whisperSecret}`,"content-type":"application/json"},
    body:JSON.stringify({text,voice:config.micSpeechVoice}),signal:combined});
  if(!response.ok){await response.body?.cancel();throw new SpeechFailure(response.status===429?"busy":"synthesis_failed");}
  if(response.headers.get("content-type")!=="application/x-inkling-wav-stream"||!response.body){
    await response.body?.cancel();throw new SpeechFailure("invalid_audio");}
  const reader=response.body.getReader();let pending:Buffer=Buffer.alloc(0),total=0,count=0,seconds=0,complete=false;
  try {
    while(true){
      const {value,done}=await reader.read();
      if(done){if(!complete||pending.length)throw new SpeechFailure("invalid_audio");return;}
      if(complete)throw new SpeechFailure("invalid_audio");
      const merged=Buffer.concat([pending,value]);pending.fill(0);pending=merged;
      if(pending.length>MAX_AUDIO+32)throw new SpeechFailure("invalid_audio");
      while(pending.length>=4){
        const size=pending.readUInt32BE(0);
        if(size===0){
          if(!count||pending.length!==4)throw new SpeechFailure("invalid_audio");
          pending.fill(0);pending=Buffer.alloc(0);complete=true;break;
        }
        if(size<44||size>MAX_AUDIO)throw new SpeechFailure("invalid_audio");
        if(pending.length<4+size)break;
        const wav=Buffer.from(pending.subarray(4,4+size));
        const rest=Buffer.from(pending.subarray(4+size));pending.fill(0);pending=rest;
        try {
          total+=wav.length;seconds+=speechPcm(wav).length/48000;
          if(++count>8||total>MAX_AUDIO||seconds>45)throw new SpeechFailure("invalid_audio");
          yield wav;
        } finally {wav.fill(0);}
      }
    }
  } catch(error) {
    if(error instanceof SpeechFailure)throw error;
    throw new SpeechFailure(signal.aborted?"cancelled":combined.aborted?"timeout":"synthesis_failed");
  } finally {pending.fill(0);await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export async function* synthesizeSpeechChunks(text:string,signal:AbortSignal):AsyncGenerator<Buffer> {
  // Drain the bounded network response independently of speaker backpressure. Otherwise a long
  // spoken answer could hit the HTTP deadline even though synthesis had already finished.
  const local=new AbortController(),combined=AbortSignal.any([signal,local.signal]);
  const queue:Buffer[]=[];let done=false,failure:unknown,wake:(()=>void)|undefined;
  const notify=()=>{wake?.();wake=undefined;};
  const producer=(async()=>{
    try {for await(const wav of readSpeechChunks(text,combined)){queue.push(Buffer.from(wav));notify();}}
    catch(error){failure=error;}
    finally {done=true;notify();}
  })();
  try {
    while(true){
      if(signal.aborted)throw new SpeechFailure("cancelled");
      if(failure)throw failure;
      const chunk=queue.shift();
      if(chunk){try{yield chunk;}finally{chunk.fill(0);}continue;}
      if(done)return;
      await new Promise<void>(resolve=>{wake=resolve;});
    }
  } catch(error) {
    if(error instanceof SpeechFailure)throw error;
    throw new SpeechFailure(signal.aborted?"cancelled":error instanceof Error&&error.name==="TimeoutError"?"timeout":"synthesis_failed");
  } finally {local.abort();await producer;for(const chunk of queue)chunk.fill(0);}
}

export function playSpeech(pcm:Buffer,signal:AbortSignal,started:()=>void):Promise<void> {
  return playSpeechChunks((async function*(){yield pcm;})(),signal,started);
}

/** One process for the whole utterance, with bounded stream backpressure and cancellation. */
export async function playSpeechChunks(chunks:AsyncIterable<Buffer>,signal:AbortSignal,started:()=>void):Promise<void> {
  const iterator=chunks[Symbol.asyncIterator]();
  let child:ReturnType<typeof spawn>|undefined,kill:NodeJS.Timeout|undefined,timeout:NodeJS.Timeout|undefined;
  const stop=()=>{child?.kill("SIGTERM");kill??=setTimeout(()=>child?.kill("SIGKILL"),1000);kill.unref();};
  const abort=()=>stop();signal.addEventListener("abort",abort,{once:true});
  try {
    const first=await iterator.next();
    if(first.done||signal.aborted)throw new SpeechFailure("cancelled");
    child=spawn("pw-play",["--target",config.micSpeechSink!,"--properties","{ node.dont-reconnect = true node.dont-fallback = true }",
      "--raw","--rate","24000","--channels","1","--format","s16","-"],{stdio:["pipe","ignore","ignore"]});
    const player=child;let ended=false,failed=false;
    const closed=new Promise<void>((resolve,reject)=>{
      player.once("error",()=>{failed=true;reject(new SpeechFailure("playback_failed"));});
      player.once("close",code=>{ended=true;signal.aborted||code!==0?reject(new SpeechFailure(signal.aborted?"cancelled":"playback_failed")):resolve();});
    });
    void closed.catch(()=>{});
    player.stdin!.on("error",()=>{failed=true;stop();});
    player.once("spawn",()=>{if(signal.aborted)stop();else started();});
    timeout=setTimeout(stop,50_000);timeout.unref();
    let total=0;
    const write=async(pcm:Buffer)=>{
      total+=pcm.length;
      if(signal.aborted||ended||failed)throw new SpeechFailure(signal.aborted?"cancelled":"playback_failed");
      if(!pcm.length||pcm.length%2||total>45*48000)throw new SpeechFailure("invalid_audio");
      // Wait for the write callback before releasing/zeroing this producer-owned buffer.
      await new Promise<void>((resolve,reject)=>{
        const cancel=()=>reject(new SpeechFailure("cancelled"));signal.addEventListener("abort",cancel,{once:true});
        player.stdin!.write(pcm,error=>{signal.removeEventListener("abort",cancel);error?reject(new SpeechFailure("playback_failed")):resolve();});
      });
    };
    await write(first.value);
    while(true){const next=await iterator.next();if(next.done)break;await write(next.value);}
    player.stdin!.end();await closed;
  } catch(error) {stop();throw error;}
  finally {signal.removeEventListener("abort",abort);clearTimeout(timeout);
    try{await iterator.return?.();}finally{if(child&&!child.killed)child.kill("SIGTERM");
      if(kill){if(child?.exitCode!==null||child?.signalCode)clearTimeout(kill);else child?.once("close",()=>clearTimeout(kill));}}}
}

export type RoomSpeechDependencies = {
  muted: ()=>boolean;
  ready?: ()=>Promise<void>;
  quiet?: ()=>Promise<void>;
  synthesize?: (text:string)=>Promise<Buffer>;
  stream?: (text:string,signal:AbortSignal)=>AsyncIterable<Buffer>;
  playChunks?: (chunks:AsyncIterable<Buffer>,signal:AbortSignal,started:()=>void)=>Promise<void>;
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
  private filler?:Buffer;
  private fillerLoaded=false;
  private fillerTimer?:NodeJS.Timeout;
  private fillerAbort?:AbortController;
  private fillerPlaying?:Promise<void>;
  constructor(private deps:RoomSpeechDependencies){
    const owner=getUsers().find(u=>u.owner);
    if(this.configured()&&owner)this.enabled=readSealedJson<{enabled:boolean}>(chatFile(owner.id,"mic-speech.json"),{enabled:false}).enabled===true;
    this.state=this.enabled?"ready":"off";
    if(this.enabled)void this.warmFiller();
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
    if(this.enabled)void this.warmFiller();
    return this.enabled?"Room speech is on for your physical mic replies. Answers will be audible in the room; WhatsApp text stays on.":"Room speech is off. Mic replies still go to WhatsApp.";
  }
  interrupt():void {this.turn=undefined;this.active?.abort();void this.stopFiller();this.state=this.enabled?"ready":"off";this.reason="cancelled";}
  cancelTurn(owner:string,id:string):void {if(this.turn?.owner===owner&&this.turn.id===id)this.interrupt();}
  private async warmFiller():Promise<void> {
    if(!config.micSpeechFiller||this.fillerLoaded||!this.configured())return;
    this.fillerLoaded=true;
    let wav:Buffer|undefined;
    try {
      wav=await (this.deps.synthesize??synthesizeSpeech)("Hmm.");const pcm=speechPcm(wav);
      if(pcm.length>48000*1.5)throw new SpeechFailure("invalid_audio");
      this.filler=Buffer.from(pcm);
      for(let at=0;at<this.filler.length;at+=2)this.filler.writeInt16LE(Math.round(this.filler.readInt16LE(at)*.45),at);
      log.info("room speech acknowledgement cached");
    } catch {log.info("room speech acknowledgement unavailable; normal replies unchanged");}
    finally {wav?.fill(0);}
  }
  private async stopFiller():Promise<void> {
    clearTimeout(this.fillerTimer);this.fillerTimer=undefined;this.fillerAbort?.abort();
    await this.fillerPlaying?.catch(()=>{});
  }
  sealed(owner:string,id:string):void {
    const turn=this.turn;
    if(!config.micSpeechFiller||!turn||turn.owner!==owner||turn.id!==id)return;
    clearTimeout(this.fillerTimer);
    this.fillerTimer=setTimeout(()=>{
      this.fillerTimer=undefined;
      const valid=()=>this.turn===turn&&this.enabled&&this.owner(owner)&&this.deps.muted();
      if(!this.filler||!valid()||this.state==="speaking")return;
      const abort=new AbortController();this.fillerAbort=abort;
      this.fillerPlaying=(async()=>{
        let audio:Buffer|undefined;
        try {
          await (this.deps.ready??speakerReady)();await (this.deps.quiet??musicQuiet)();
          if(!valid()||abort.signal.aborted||this.state==="speaking")return;
          audio=Buffer.from(this.filler!);
          await (this.deps.play??playSpeech)(audio,abort.signal,()=>log.info({id},"room speech acknowledgement started"));
        } catch { /* Optional acknowledgement must never fail the actual reply. */ }
        finally {audio?.fill(0);if(this.fillerAbort===abort){this.fillerAbort=undefined;this.fillerPlaying=undefined;}}
      })();
    },1000);this.fillerTimer.unref();
  }
  capture(owner:string,id:string,physical:boolean):void {
    this.interrupt();
    if(physical&&this.configured()&&this.enabled&&this.owner(owner))this.turn={owner,id,used:false,at:Date.now()};
  }
  async reply(owner:string,id:string,text:string,doneAt?:number):Promise<void> {
    const turn=this.turn;
    if(!turn||turn.used||turn.owner!==owner||turn.id!==id)return;
    turn.used=true;
    const valid=()=>this.turn===turn&&this.enabled&&this.configured()&&this.owner(owner)&&this.deps.muted()&&Date.now()-turn.at<120_000;
    if(!valid()){await this.stopFiller();return;}
    const speech=speechText(text);
    if(!speech){await this.stopFiller();this.state="unavailable";this.reason="unsupported_text";return;}
    if(this.working){await this.stopFiller();this.state="unavailable";this.reason="busy";return;}
    this.working=true;const abort=new AbortController();this.active=abort;
    let wav:Buffer|undefined,watch:NodeJS.Timeout|undefined,checking=false;
    const started=Date.now();
    const ready=async()=>{await (this.deps.ready??speakerReady)();await (this.deps.quiet??musicQuiet)();};
    try {
      await ready();if(!valid())throw new SpeechFailure("cancelled");
      this.state="synthesizing";this.reason=undefined;
      const synthAt=Date.now();
      const watchPlayback=()=>{
        watch=setInterval(()=>{if(checking)return;checking=true;
          void (async()=>{try {if(!valid())throw new SpeechFailure("cancelled");await ready();}
            catch {abort.abort();}finally{checking=false;}})();},1000);watch.unref();
      };
      const playbackStarted=()=>{
        if(!valid()){abort.abort();return;}
        this.state="speaking";log.info({id,firstPlaybackMs:Date.now()-started,
          muteToPlaybackMs:doneAt===undefined?undefined:Math.max(0,Date.now()-doneAt)},"room speech playback started");
      };
      if(config.micSpeechStreaming){
        const thisRoom=this;
        const source=(this.deps.stream??synthesizeSpeechChunks)(speech,abort.signal);
        const pcmChunks=async function*(){
          let count=0,bytes=0;
          for await(const chunk of source){
            try {
              const pcm=speechPcm(chunk);bytes+=chunk.length;
              if(!valid())throw new SpeechFailure("cancelled");
              if(count++===0){await thisRoom.stopFiller();await ready();if(!valid())throw new SpeechFailure("cancelled");
                log.info({id,firstChunkMs:Date.now()-synthAt,bytes:chunk.length},"room speech first chunk ready");}
              yield pcm;
            } finally {chunk.fill(0);}
          }
          log.info({id,feedMs:Date.now()-synthAt,bytes,chunks:count},"room speech stream completed");
        };
        watchPlayback();await (this.deps.playChunks??playSpeechChunks)(pcmChunks(),abort.signal,playbackStarted);
      } else {
        wav=await (this.deps.synthesize??synthesizeSpeech)(speech);
        log.info({id,synthesisMs:Date.now()-synthAt,bytes:wav.length},"room speech synthesized");
        const pcm=speechPcm(wav);await this.stopFiller();await ready();if(!valid())throw new SpeechFailure("cancelled");
        watchPlayback();await (this.deps.play??playSpeech)(pcm,abort.signal,playbackStarted);
      }
      if(abort.signal.aborted)throw new SpeechFailure("cancelled");
      if(this.turn===turn){this.state=this.enabled?"ready":"off";this.reason="played";}
      log.info({id,totalMs:Date.now()-started},"room speech playback completed");
    } catch(error) {
      const reason=error instanceof SpeechFailure?error.reason:"playback_failed";
      if(this.turn===turn){this.state=this.enabled?(reason==="cancelled"?"ready":"unavailable"):"off";this.reason=reason;}
      log.info({id,reason},"room speech skipped or stopped");
    } finally {if(this.turn===turn)await this.stopFiller();clearInterval(watch);wav?.fill(0);if(this.active===abort)this.active=undefined;this.working=false;}
  }
}
