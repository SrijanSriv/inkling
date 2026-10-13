import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const FRAME = 3200; // 100 ms, 16 kHz mono signed PCM16.
export type SwitchState = "waiting-for-mute" | "armed" | "recording" | "blocked";
export type PiMicrophoneInput = { ready: boolean; drain?(): Buffer; close(): void };

/** Signal inference only: exact digital zero is different from quiet speech, not proof of a hardware event. */
export class MicrophoneMuteGate {
  state: SwitchState = "waiting-for-mute";
  private zeros = 0;
  private onset: Buffer[] = [];
  constructor(private start: (first: Buffer[])=>boolean, private end: ()=>void) {}
  reset(): void { this.state="waiting-for-mute";this.zeros=0;this.clear(); }
  private clear(): void {for(const frame of this.onset)frame.fill(0);this.onset=[];}
  feed(frame: Buffer, capturing: boolean): void {
    const zero = frame.every(byte=>byte===0);
    this.zeros = zero ? this.zeros+1 : 0;
    if (this.state === "recording") {
      if (!capturing) {this.state="blocked";this.clear();}
      else if (this.zeros >= 3) {this.state="armed";this.clear();this.end();}
      return;
    }
    if (this.state !== "armed") {
      if (this.zeros >= 10) this.state="armed"; // Ignore startup transients; first observe a muted baseline.
      return;
    }
    if (zero) {this.clear();return;}
    this.onset.push(Buffer.from(frame));
    if (this.onset.length < 2) return;
    // Preserve the very first nonzero frame, including a first syllable before debounce completed.
    this.state = this.start(this.onset) ? "recording" : "blocked";
    this.clear();
  }
}

/** One optional warm input. Idle frames are discarded, never uploaded, transcribed or saved. */
export class WarmMicrophoneInput {
  ready = false;
  private process?: ChildProcessWithoutNullStreams;
  private retry?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private stopped = false;
  private tail: Buffer = Buffer.alloc(0);
  constructor(private source: string, private frame: (pcm:Buffer)=>void, private unavailable: ()=>void) {this.open();}
  drain(): Buffer {
    const length=this.tail.length-this.tail.length%2;
    const pending=Buffer.from(this.tail.subarray(0,length));
    const odd=Buffer.from(this.tail.subarray(length));this.tail.fill(0);this.tail=odd;
    return pending;
  }
  private open(): void {
    if (this.stopped) return;
    const child=spawn("pw-record",["--raw","--target",this.source,"--rate","16000","--channels","1","--format","s16","-"],{stdio:"pipe"});
    this.process=child;
    let last=Date.now(), failed=false;
    const lost=()=>{
      if(failed)return;failed=true;this.ready=false;this.tail.fill(0);this.tail=Buffer.alloc(0);
      clearInterval(this.watchdog);this.unavailable();child.kill("SIGTERM");
      const kill=setTimeout(()=>child.kill("SIGKILL"),1500);kill.unref();child.once("close",()=>clearTimeout(kill));
      if(!this.stopped){this.retry=setTimeout(()=>this.open(),5000);this.retry.unref();}
    };
    child.stderr.resume();child.once("error",lost);child.once("close",lost);
    child.stdout.on("data",(data:Buffer)=>{
      if(this.stopped||failed)return;
      last=Date.now();this.ready=true;
      const combined=this.tail.length?Buffer.concat([this.tail,data]):data;
      let offset=0;
      for(;offset+FRAME<=combined.length;offset+=FRAME){
        const pcm=Buffer.from(combined.subarray(offset,offset+FRAME));
        try {this.frame(pcm);} catch {lost();return;} finally {pcm.fill(0);}
      }
      this.tail=Buffer.from(combined.subarray(offset));
    });
    this.watchdog=setInterval(()=>{if(Date.now()-last>2500)lost();},500);this.watchdog.unref();
  }
  close(): void {
    this.stopped=true;clearTimeout(this.retry);clearInterval(this.watchdog);this.ready=false;this.tail.fill(0);
    const child=this.process;child?.kill("SIGTERM");
    const kill=setTimeout(()=>child?.kill("SIGKILL"),1500);kill.unref();child?.once("close",()=>clearTimeout(kill));
  }
}
