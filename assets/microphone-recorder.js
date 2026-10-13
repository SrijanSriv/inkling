// Bounded PCM capture. No audio leaves the browser until release.
class MicrophoneRecorder extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer=new Float32Array(2048);this.used=0;this.frames=0;this.finished=false;
    this.port.onmessage=event=>{if(event.data==='stop')this.finish();};
  }
  flush() {
    if(!this.used)return;
    const samples=this.buffer.slice(0,this.used);this.port.postMessage({samples},[samples.buffer]);this.used=0;
  }
  finish() {if(this.finished)return;this.finished=true;this.flush();this.port.postMessage({done:true});}
  process(inputs) {
    if(this.finished)return false;
    const input=inputs[0]?.[0];if(!input)return true;
    // Reaching the limit cancels, it never silently submits truncated speech.
    if(this.frames+input.length>sampleRate*20){this.finished=true;this.port.postMessage({limit:true});return false;}
    this.frames+=input.length;
    for(const sample of input){this.buffer[this.used++]=sample;if(this.used===this.buffer.length)this.flush();}
    return true;
  }
}
registerProcessor('microphone-recorder',MicrophoneRecorder);
