import {StreamingPcmEncoder, mixAndMeasure} from './audio-core.ts';

class MeetingAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.paused = Boolean(options?.processorOptions?.startPaused);
    this.stopped = false;
    this.inFlight = 0;
    this.meterFrames = 0;
    this.encoder = new StreamingPcmEncoder(sampleRate, frame => {
      if (this.inFlight >= 5) {
        this.stopped = true;
        this.port.postMessage({type:'error', message:'音频处理落后超过 1 秒，录音已停止。请关闭高负载程序后重试。'});
        return;
      }
      this.inFlight++;
      this.port.postMessage({type:'frame', pcm:frame.buffer, at:currentTime}, [frame.buffer]);
    });
    this.port.onmessage = ({data}) => {
      if (data.type === 'ack') this.inFlight = Math.max(0, this.inFlight - 1);
      if (data.type === 'pause' && !this.stopped) {
        this.encoder.flush();
        this.paused = true;
      }
      if (data.type === 'resume' && !this.stopped) {
        this.encoder.reset();
        this.paused = false;
      }
      if (data.type === 'stop') {
        if (!this.stopped) this.encoder.flush();
        this.stopped = true;
        this.port.postMessage({type:'stopped'});
      }
    };
  }
  process(inputs, outputs) {
    // A silent connected output keeps Chromium rendering the node; captured
    // audio is never sent to the speakers (and cannot create feedback).
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    if (this.paused) return true;
    const size = inputs[0]?.[0]?.length || inputs[1]?.[0]?.length || 128;
    const mixed = mixAndMeasure(inputs[0] || [], inputs[1] || [], size);
    this.encoder.push(mixed.samples);
    this.meterFrames += size;
    if (this.meterFrames >= sampleRate / 10) {
      this.meterFrames = 0;
      if (this.inFlight < 5) this.port.postMessage({type:'levels', mic:mixed.mic, system:mixed.system});
    }
    return !this.stopped;
  }
}
registerProcessor('meeting-audio', MeetingAudioProcessor);
