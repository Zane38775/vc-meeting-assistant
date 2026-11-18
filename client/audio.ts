/// <reference types="vite/client" />
import workletUrl from './pcm-worklet.js?worker&url';

export interface CaptureOptions {
  mode: 'online' | 'offline';
  deviceId?: string;
  startPaused?: boolean;
  signal?: AbortSignal;
  onChunk: (chunk: {pcm: string; capturedAt: number; seq: number}) => void;
  onLevels: (levels: {mic: number; system: number}) => void;
  onError: (error: Error) => void;
}
export interface CaptureHandle {stop(): Promise<void>; pause(): void; resume(): void}

declare global {
  interface Window {
    vcDesktop?: {platform: string; authorizeCapture(mode:'online'|'offline'):Promise<void>; releaseCapture():void};
  }
}

let occupied = false;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

export async function captureAudio(options: CaptureOptions): Promise<CaptureHandle> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (!navigator.userActivation?.isActive) throw new Error('请点击“开始录音”来授权麦克风和系统音频。');
  if (occupied) throw new Error('已有录音正在进行，请先停止。');
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error('当前环境不支持安全音频采集，请使用桌面应用或 HTTPS / localhost。');
  occupied = true;
  const streams: MediaStream[] = [];
  const nodes: AudioNode[] = [];
  const trackListeners: Array<() => void> = [];
  let context: AudioContext | undefined;
  let processor: AudioWorkletNode | undefined;
  let state: 'starting'|'running'|'paused'|'stopping'|'stopped' = 'starting';
  let failed = false;
  let seq = 0;
  let anchor = 0;
  let finishStop: ((error?: Error) => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let lastFrame = performance.now();

  const cleanup = () => cleanupPromise ??= (async () => {
    state = 'stopped';
    if (watchdog) clearInterval(watchdog);
    trackListeners.forEach(remove => remove());
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    for (const node of nodes) node.disconnect();
    if (processor) {processor.port.onmessage = null; processor.port.close();}
    if (context && context.state !== 'closed') await context.close().catch(() => {});
    window.vcDesktop?.releaseCapture();
    occupied = false;
    options.onLevels({mic:0, system:0});
  })();
  let abortInitialization!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abortInitialization = () => reject(signal?.reason);
    signal?.addEventListener('abort', abortInitialization, {once:true});
  });
  void cancelled.catch(() => {});
  const duringInitialization = <T>(operation: Promise<T>) => Promise.race([operation, cancelled]);
  const fail = (error: unknown) => {
    if (state === 'stopping') { finishStop?.(asError(error)); return; }
    if (failed || state === 'stopped') return;
    failed = true;
    void cleanup();
    options.onError(asError(error));
  };
  const acquire = async (promise: Promise<MediaStream>, label: string): Promise<MediaStream> => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tracked = promise.then(stream => {
      if (timedOut || state === 'stopped' || failed || signal?.aborted) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error(`${label}授权已超时，请重新开始。`);
      }
      streams.push(stream);
      return stream;
    });
    try {
      return await duringInitialization(Promise.race([tracked, new Promise<never>((_, reject) => {
        timer = setTimeout(() => {timedOut = true; reject(new Error(`${label}授权超时，请确认系统权限后重新开始。`));}, 60000);
      })]));
    } finally { if (timer) clearTimeout(timer); }
  };
  const validate = (stream: MediaStream, label: string) => {
    const tracks = stream.getAudioTracks();
    if (!tracks.length || !tracks.some(track => track.readyState === 'live')) throw new Error(`${label}没有可用音轨。Mac 请在系统设置 → 隐私与安全性中允许麦克风与系统音频录制；浏览器请勾选“共享音频”。`);
    for (const track of tracks) {
      const ended = () => fail(new Error(`${label}已断开，录音已停止。请重新连接设备后再开始。`));
      track.addEventListener('ended', ended);
      trackListeners.push(() => track.removeEventListener('ended', ended));
    }
  };

  try {
    if (window.vcDesktop) await duringInitialization(window.vcDesktop.authorizeCapture(options.mode));
    // Request display capture first while the initiating click is still active.
    // Both promises start together and late-granted streams are always released.
    let displayRequest: Promise<MediaStream> | undefined;
    if (options.mode === 'online') {
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error('当前环境不支持系统音频采集，请使用 macOS 14.2+ 或 Windows 桌面应用。');
      displayRequest = acquire(navigator.mediaDevices.getDisplayMedia({
        audio: {echoCancellation:false, noiseSuppression:false, autoGainControl:false},
        video: {frameRate:1, width:16, height:16},
        systemAudio:'include',
      } as DisplayMediaStreamOptions), '系统音频');
      // Mark as handled even if microphone acquisition rejects first.
      void displayRequest.catch(() => {});
    }
    const micRequest = acquire(navigator.mediaDevices.getUserMedia({audio:{
      deviceId: options.deviceId ? {exact:options.deviceId} : undefined,
      channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true,
    }, video:false}), '麦克风');
    const [mic, system] = await Promise.all([micRequest, displayRequest]);
    validate(mic, '麦克风');
    if (system) validate(system, '系统音频');
    if (options.startPaused) streams.forEach(stream => stream.getAudioTracks().forEach(track => {track.enabled = false;}));
    context = new AudioContext({latencyHint:'interactive'});
    if (!context.audioWorklet) throw new Error('当前浏览器不支持 AudioWorklet，请升级浏览器或使用桌面应用。');
    await duringInitialization(context.audioWorklet.addModule(workletUrl));
    if (failed) throw new Error('音频设备在初始化过程中断开。');
    processor = new AudioWorkletNode(context, 'meeting-audio', {
      numberOfInputs:2, numberOfOutputs:1, outputChannelCount:[1], channelCountMode:'max',
      processorOptions:{startPaused:options.startPaused},
    });
    nodes.push(processor);
    processor.onprocessorerror = () => fail(new Error('音频处理器意外停止，请重新开始录音。'));
    processor.port.onmessage = ({data}) => {
      if (state === 'stopped' || failed) return;
      if (data.type === 'frame') {
        lastFrame = performance.now();
        try {
          const bytes = new Uint8Array(data.pcm);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          options.onChunk({pcm:btoa(binary), capturedAt:Math.round(anchor + data.at * 1000 - 200), seq:seq++});
        } catch (error) {fail(error);}
        processor?.port.postMessage({type:'ack'});
      } else if (data.type === 'levels' && state === 'running') options.onLevels({mic:data.mic, system:data.system});
      else if (data.type === 'error') fail(new Error(data.message));
      else if (data.type === 'stopped') finishStop?.();
    };
    const connect = (stream: MediaStream, index: number) => {
      // Do not process, encode or retain any display video frames.
      const source = context!.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      source.connect(processor!, 0, index);
      nodes.push(source);
    };
    connect(mic, 0);
    if (system) connect(system, 1);
    processor.connect(context.destination);
    await duringInitialization(context.resume());
    if (context.state !== 'running') throw new Error('音频设备尚未启动，请再次点击开始录音。');
    anchor = Date.now() - context.currentTime * 1000;
    state = options.startPaused ? 'paused' : 'running';
    lastFrame = performance.now();
    watchdog = setInterval(() => {
      if (state === 'running' && performance.now() - lastFrame > 3000) fail(new Error('超过 3 秒未收到音频数据，录音已停止。请检查设备或系统休眠状态。'));
    }, 1000);
    return {
      stop() {
        if (stopPromise) return stopPromise;
        if (state === 'stopped') return Promise.resolve();
        state = 'stopping';
        if (watchdog) clearInterval(watchdog);
        streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
        stopPromise = (async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await new Promise<void>((resolve, reject) => {
              finishStop = error => { if (error) reject(error); else resolve(); };
              timeout = setTimeout(() => reject(new Error('等待最后一段音频确认超时')), 350);
              processor?.port.postMessage({type:'stop'});
            });
          } finally {
            clearTimeout(timeout);
            finishStop = undefined;
            await cleanup();
          }
        })();
        return stopPromise;
      },
      pause() {
        if (state !== 'running') return;
        state = 'paused';
        streams.forEach(stream => stream.getAudioTracks().forEach(track => {track.enabled = false;}));
        processor?.port.postMessage({type:'pause'});
        options.onLevels({mic:0, system:0});
      },
      resume() {
        if (state !== 'paused') return;
        if (streams.some(stream => stream.getAudioTracks().some(track => track.readyState !== 'live'))) {
          fail(new Error('音频设备已断开，请重新开始录音。')); return;
        }
        streams.forEach(stream => stream.getAudioTracks().forEach(track => {track.enabled = true;}));
        processor?.port.postMessage({type:'resume'});
        lastFrame = performance.now();
        state = 'running';
      },
    };
  } catch (error) {
    failed = true;
    await cleanup();
    throw asError(error);
  } finally { signal?.removeEventListener('abort', abortInitialization); }
}
