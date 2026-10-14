/** Provisional audio is never playable until its text matches the final checked reply. */
export type VoicePreparation = { text(value:string):void; invalidate():void };
export type PreparedOpening = { text:string; wav:Buffer };

const ABBREVIATION = /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;

/** The same natural-boundary/minimum-size policy as the laptop splitter, applied to a growing prefix. */
export function openingPhrase(text:string):string|undefined {
  for(const match of text.matchAll(/[,.!?;:।]["')]*\s+/g)){
    const end=match.index!+match[0].length,before=text.slice(0,match.index),after=text.slice(end);
    if(!after.trim())continue; // No useful overlap if this is all the answer so far.
    const token=before.trim().split(/\s+/).at(-1)??"",mark=match[0][0];
    if(mark==="."&&(ABBREVIATION.test(token)||/^(?:[A-Za-z]\.)*[A-Za-z]$/.test(token)))continue;
    if((mark===","||mark===":")&&/\d$/.test(before)&&/^\d/.test(after))continue;
    const words=text.slice(0,end).trim().split(/\s+/).length,sentence=/[.!?।]/.test(mark);
    if(words>=(sentence?6:8)&&words<=(sentence?24:18))return text.slice(0,end).trim();
  }
}

export class SpeechPreparation implements VoicePreparation {
  private blocked=false;
  private consumed=false;
  private candidate?:string;
  private pending?:Promise<Buffer|undefined>;
  private held?:Buffer;
  private abort=new AbortController();
  constructor(private clean:(text:string)=>string|undefined,
    private synthesize:(text:string,signal:AbortSignal)=>Promise<Buffer>){}
  text(value:string):void {
    if(this.blocked||this.consumed||this.pending)return;
    const clean=this.clean(value);
    if(!clean){this.invalidate();return;}
    const opening=openingPhrase(clean);
    if(!opening)return;
    this.candidate=opening;
    this.pending=Promise.resolve().then(()=>this.synthesize(opening,this.abort.signal)).then(wav=>{
      if(this.blocked||this.abort.signal.aborted){wav.fill(0);return;}
      this.held=wav;return wav;
    }).catch(()=>undefined); // Speculative failure must not fail the assistant turn.
  }
  invalidate():void {this.blocked=true;this.held?.fill(0);this.held=undefined;}
  cancel():void {this.invalidate();this.abort.abort();}
  async take(final:string):Promise<PreparedOpening|undefined> {
    if(this.consumed)return;
    this.consumed=true;
    const wav=await this.pending;
    this.held=undefined;
    if(!wav)return;
    const opening=this.candidate!;
    const tail=final.slice(opening.length).trim();
    if(this.blocked||this.abort.signal.aborted||!final.startsWith(opening)
      ||(final.length>opening.length&&!/\s/u.test(final[opening.length]))
      ||(tail&&tail.split(/\s+/).length<8)){wav.fill(0);return;}
    return {text:opening,wav};
  }
}
