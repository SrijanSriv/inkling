/** Play the existing gateway's bounded WAV frames locally; credentials stay in fetch headers. */
export class MicrophoneSpeaker {
  constructor(notice){this.notice=notice;this.sources=new Set();this.generation=0;}
  async unlock(){
    this.context??=new AudioContext();
    await this.context.resume();
    if(this.context.state!=='running')throw new Error('Tap Enable sound to allow spoken replies.');
  }
  stop(){
    this.generation++;this.abort?.abort();this.abort=undefined;
    for(const source of this.sources){try{source.stop();}catch{}source.disconnect();}
    this.sources.clear();this.active=false;
  }
  async play(url,token,onFirst){
    this.stop();const generation=this.generation;
    if(!this.context||this.context.state!=='running')throw new Error('Tap Enable sound to allow spoken replies.');
    const abort=new AbortController();this.abort=abort;this.active=true;
    let reader,pending=new Uint8Array(),count=0,total=0,seconds=0,complete=false,next=this.context.currentTime;
    const deadline=setTimeout(()=>abort.abort(),55000);
    try{
      const response=await fetch(url,{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:abort.signal});
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||'Spoken reply unavailable.');}
      if(response.headers.get('content-type')!=='application/x-inkling-wav-stream'||!response.body)throw new Error('Invalid speech response.');
      reader=response.body.getReader();
      while(true){
        const {value,done}=await reader.read();
        if(done){if(!complete||pending.length)throw new Error('Speech was interrupted. The text reply is still available.');break;}
        if(complete)throw new Error('Invalid speech response.');
        const merged=new Uint8Array(pending.length+value.length);merged.set(pending);merged.set(value,pending.length);pending=merged;
        if(pending.length>2200032)throw new Error('Speech response too large.');
        while(pending.length>=4){
          const size=new DataView(pending.buffer,pending.byteOffset,4).getUint32(0);
          if(!size){if(!count||pending.length!==4)throw new Error('Invalid speech ending.');pending=new Uint8Array();complete=true;break;}
          if(size<44||size>2200000)throw new Error('Invalid speech frame.');
          if(pending.length<size+4)break;
          const wav=pending.slice(4,size+4);pending=pending.slice(size+4);
          total+=size;if(++count>8||total>2200000)throw new Error('Speech response too large.');
          const buffer=await this.context.decodeAudioData(wav.buffer);
          seconds+=buffer.duration;
          if(seconds>45||buffer.numberOfChannels!==1||buffer.sampleRate!==this.context.sampleRate&&buffer.sampleRate!==24000)throw new Error('Invalid speech format.');
          if(generation!==this.generation||abort.signal.aborted)return;
          const source=this.context.createBufferSource();source.buffer=buffer;source.connect(this.context.destination);this.sources.add(source);
          source.onended=()=>{this.sources.delete(source);source.disconnect();};
          next=Math.max(next,this.context.currentTime+.06);source.start(next);next+=buffer.duration;
          if(count===1){this.notice('Speaking on this device…');onFirst?.();}
        }
      }
      while(this.sources.size&&generation===this.generation&&!abort.signal.aborted)await new Promise(resolve=>setTimeout(resolve,50));
      if(generation===this.generation&&!abort.signal.aborted)this.notice('Spoken reply finished.');
    }catch(error){if(generation===this.generation&&!abort.signal.aborted){this.stop();throw error;}}
    finally{clearTimeout(deadline);await reader?.cancel().catch(()=>{});if(generation===this.generation){if(abort.signal.aborted)this.stop();else{this.active=false;this.abort=undefined;}}}
  }
}
