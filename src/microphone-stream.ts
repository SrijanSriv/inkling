import { createHash } from 'node:crypto';
import { config } from './config.js';

type State = { id: string; state: string; revision: number; receivedBytes: number; decodedBytes: number;
  draft?: string; stable?: string; nativeBusy?: boolean; result?: { text: string; warning?: string } | null };
/** One bounded session; every final transcript still covers the entire exact recording. */
export class MicrophoneStream {
  private id?: string;
  private failed = false;
  private cancelled = false;
  private ready: Promise<void>;
  private pending: Buffer[] = [];
  private buffered = 0;
  private total = 0;
  private sent = 0;
  private hash = createHash('sha256');
  private draining?: Promise<void>;
  private poller?: NodeJS.Timeout;
  private polling = false;
  private lastDraft = "";
  private abort = new AbortController();
  constructor(private draft: (text: string) => void) {
    this.ready = this.request('/microphone/session','POST').then(state=>{
      this.id=state.id;
      if(this.cancelled||this.failed){void this.cancelRemote();return;}
      this.poller=setInterval(()=>void this.poll(),500);this.poller.unref();
    }).catch(()=>{this.failed=true;this.clearPending();});
  }
  private async request(path: string, method='GET', body?: Buffer, headers: Record<string,string> = {}): Promise<State> {
    const response=await fetch(new URL(path,config.whisperUrl!), {method,
      headers:{authorization:`Bearer ${config.whisperSecret}`, ...(body?{'content-type':'application/octet-stream'}:{}),...headers},
      body:body?new Uint8Array(body):undefined,signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(5000)])});
    if(!response.ok)throw new Error('Incremental recognition unavailable');
    const raw=await response.text();if(raw.length>128000)throw new Error('Recognition reply too large');
    const state=JSON.parse(raw) as State;
    if(!/^[a-f0-9]{32}$/.test(state.id)||(this.id&&state.id!==this.id)||typeof state.state!=='string')throw new Error('Invalid recognition session');
    return state;
  }
  private clearPending(){for(const chunk of this.pending)chunk.fill(0);this.pending=[];this.buffered=0;}
  append(pcm: Buffer): void {
    if(this.failed||this.cancelled)return;
    if(!pcm.length||pcm.length%2||this.total+pcm.length>640000||this.buffered+pcm.length>32000){this.fail();return;}
    this.hash.update(pcm);this.total+=pcm.length;
    this.pending.push(Buffer.from(pcm));this.buffered+=pcm.length;
    if(this.buffered>=16000)void this.drain();
  }
  private drain(): Promise<void> {
    if(this.draining)return this.draining;
    this.draining=(async()=>{
      await this.ready;
      while(this.pending.length&&!this.failed&&!this.cancelled){
        const chunk=this.pending.shift()!;this.buffered-=chunk.length;
        try {
          const state=await this.request(`/microphone/session/${this.id}/audio`,'POST',chunk,{'X-Inkling-Offset':String(this.sent)});
          if(state.receivedBytes!==this.sent+chunk.length)throw new Error('Audio acknowledgement mismatch');
          this.sent+=chunk.length;
        } finally {chunk.fill(0);}
      }
    })().catch(()=>this.fail()).finally(()=>{this.draining=undefined;});
    return this.draining;
  }
  private async poll(){
    if(this.polling||this.failed||this.cancelled||!this.id)return;
    this.polling=true;
    try {const state=await this.request(`/microphone/session/${this.id}`);
      if(typeof state.draft==='string'&&state.draft.trim()&&state.draft.length<=16000&&state.draft!==this.lastDraft){this.lastDraft=state.draft;this.draft(state.draft);}
    } catch {this.fail();} finally {this.polling=false;}
  }
  private fail(){this.failed=true;clearInterval(this.poller);this.clearPending();void this.cancelRemote();}
  private async cancelRemote(){if(this.id)await this.request(`/microphone/session/${this.id}`,'DELETE').catch(()=>{});}
  async finish(pcm: Buffer, signal: AbortSignal): Promise<{text:string;warning?:string}> {
    clearInterval(this.poller);
    await this.ready;
    if(this.failed||this.cancelled||signal.aborted||!this.total||this.total>pcm.length
      ||!createHash('sha256').update(pcm.subarray(0,this.total)).digest().equals(this.hash.copy().digest()))throw new Error('Streaming capture incomplete');
    // Browser flush may leave a final packet pending. Send missing samples from the exact final WAV, never guess.
    await this.drain();
    for(let offset=this.total;offset<pcm.length;offset+=16000){
      this.append(pcm.subarray(offset,Math.min(pcm.length,offset+16000)));await this.drain();
    }
    if(this.failed||this.sent!==pcm.length)throw new Error('Streaming audio incomplete');
    await this.request(`/microphone/session/${this.id}/finish`,'POST',undefined,{'X-Inkling-Size':String(pcm.length)});
    const deadline=Date.now()+190_000;
    while(Date.now()<deadline&&!signal.aborted&&!this.cancelled){
      const state=await this.request(`/microphone/session/${this.id}`);
      if(state.state==='done'&&state.result&&typeof state.result.text==='string'&&state.result.text.trim()&&state.result.text.length<=16000
        &&(!state.result.warning||typeof state.result.warning==='string'&&state.result.warning.length<=200))return state.result;
      if(['failed','cancelled','expired'].includes(state.state)&&!state.nativeBusy)throw new Error('Streaming recognition failed');
      await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,150);signal.addEventListener('abort',done,{once:true});});
    }
    throw new Error('Streaming recognition interrupted');
  }
  async abandon(signal: AbortSignal): Promise<boolean> {
    this.cancel();await this.ready;
    if(!this.id)return true;
    const deadline=Date.now()+10_000;
    while(Date.now()<deadline&&!signal.aborted){
      try {const state=await this.request(`/microphone/session/${this.id}`);if(!state.nativeBusy)return true;}
      catch {return false;}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    return false;
  }
  cancel(){this.cancelled=true;clearInterval(this.poller);this.clearPending();void this.cancelRemote();}
}
