/** Browser microphone capture shares the Pi's 16 kHz PCM-WAV transcription path. */
export class DeviceMicrophone {
  constructor(level,onLimit,onAudio) {this.level=level;this.onAudio=onAudio;this.onLimit=onLimit;this.chunks=[];this.frames=0;this.cancelled=false;}
  static supported() {return !!(globalThis.isSecureContext&&navigator.mediaDevices?.getUserMedia&&globalThis.AudioWorkletNode);}
  static async permission() {
    if(!this.supported())throw new Error('Your device microphone needs a trusted HTTPS page (or localhost). The Pi microphone still works here.');
    const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    stream.getTracks().forEach(track=>track.stop());
  }
  async start() {
    if(!DeviceMicrophone.supported())throw new Error('Open this page using trusted HTTPS to use your device microphone.');
    this.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
    if(this.cancelled){this.close();return;}
    try {
      if(this.onAudio){try{this.context=new AudioContext({sampleRate:16000});}catch{this.context=new AudioContext();}}else this.context=new AudioContext();
      if(this.context.sampleRate>96000)throw new Error('This microphone sample rate is not supported.');
      await this.context.audioWorklet.addModule(new URL('microphone-recorder.js',import.meta.url));
      if(this.cancelled){this.close();return;}
      this.node=new AudioWorkletNode(this.context,'microphone-recorder',{numberOfInputs:1,numberOfOutputs:1,channelCount:1});
      this.done=new Promise(resolve=>{this.resolveDone=resolve;});
      this.node.port.onmessage=({data})=>{
        if(data.limit){this.onLimit();return;}
        if(data.samples&&!this.cancelled){
          this.frames+=data.samples.length;
          if(this.frames>this.context.sampleRate*20){this.onLimit();return;}
          this.chunks.push(data.samples);
          if(this.context.sampleRate===16000)this.onAudio?.(this.pcm(data.samples));
          const rms=Math.sqrt(data.samples.reduce((sum,x)=>sum+x*x,0)/data.samples.length);
          this.level({seconds:this.frames/this.context.sampleRate,level:Math.min(1,rms*10),signal:rms?'signal arriving':'no signal'});
        }
        if(data.done)this.resolveDone?.();
      };
      this.source=this.context.createMediaStreamSource(this.stream);this.source.connect(this.node);
      this.mute=this.context.createGain();this.mute.gain.value=0;this.node.connect(this.mute);this.mute.connect(this.context.destination);
      await this.context.resume();
    } catch(error) {this.cancel();throw error;}
  }
  async finish() {
    if(this.cancelled||!this.node)throw new Error('Recording cancelled.');
    this.node.port.postMessage('stop');
    this.stream.getTracks().forEach(track=>track.stop());
    let timer;
    try {await Promise.race([this.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Microphone did not finish. Try again.')),1500);})]);}
    finally {clearTimeout(timer);}
    if(this.cancelled)throw new Error('Recording cancelled.');
    const rate=this.context.sampleRate, frames=this.frames;
    if(frames<rate*.3)throw new Error('Recording too short. Hold the circle and wait for Listening before speaking.');
    const samples=new Float32Array(frames);let offset=0;
    for(const chunk of this.chunks){samples.set(chunk,offset);offset+=chunk.length;}
    this.close();this.chunks=[];
    const length=Math.floor(frames*16000/rate);
    if(rate===16000)return this.wav(this.pcm(samples));
    const render=new OfflineAudioContext(1,length,16000),buffer=render.createBuffer(1,frames,rate);
    buffer.copyToChannel(samples,0);samples.fill(0);
    const source=render.createBufferSource();source.buffer=buffer;source.connect(render.destination);source.start();
    const output=await render.startRendering();
    if(this.cancelled)throw new Error('Recording cancelled.');
    return this.wav(this.pcm(output.getChannelData(0)));
  }
  pcm(samples) {
    const buffer=new ArrayBuffer(samples.length*2),view=new DataView(buffer);
    for(let i=0;i<samples.length;i++){const value=Math.max(-1,Math.min(1,samples[i]));view.setInt16(i*2,Math.round(value*(value<0?32768:32767)),true);}
    return buffer;
  }
  wav(pcm) {
    const wav=new ArrayBuffer(44+pcm.byteLength),view=new DataView(wav);
    const word=(at,text)=>{for(let i=0;i<text.length;i++)view.setUint8(at+i,text.charCodeAt(i));};
    word(0,'RIFF');view.setUint32(4,36+pcm.byteLength,true);word(8,'WAVEfmt ');view.setUint32(16,16,true);
    view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);
    view.setUint16(32,2,true);view.setUint16(34,16,true);word(36,'data');view.setUint32(40,pcm.byteLength,true);
    new Uint8Array(wav,44).set(new Uint8Array(pcm));return wav;
  }
  close() {this.stream?.getTracks().forEach(track=>track.stop());this.source?.disconnect();this.node?.disconnect();void this.context?.close().catch(()=>{});}
  cancel() {this.cancelled=true;this.close();this.chunks=[];this.resolveDone?.();}
}
