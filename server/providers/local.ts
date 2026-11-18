import type {ASRSession,ASRCallbacks} from './contracts';
import {fork, type ForkOptions} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {localTranscriptionTerms} from './transcription-terms';
const profiles={
 'zipformer-small': {
  label:'Zipformer Small',subdirectory:'',modelType:'zipformer',modelingUnit:'cjkchar+bpe',
  files:{encoder:'encoder-epoch-99-avg-1.int8.onnx',decoder:'decoder-epoch-99-avg-1.onnx',joiner:'joiner-epoch-99-avg-1.int8.onnx',tokens:'tokens.txt'},
 },
 'xasr-480': {
  label:'X-ASR 480 ms',subdirectory:'xasr-480',modelType:'zipformer2',modelingUnit:'bpe',
  files:{encoder:'encoder.int8.onnx',decoder:'decoder.onnx',joiner:'joiner.int8.onnx',tokens:'tokens.txt'},
 },
} as const;
type LocalASRProfile=keyof typeof profiles;
export const LOCAL_MODEL_FILES=Object.values(profiles['zipformer-small'].files);
export function localModelDirectory():string {return resolve(process.env.ASR_MODEL_DIR||join((process as NodeJS.Process&{resourcesPath?:string}).resourcesPath||process.cwd(),'models','local-asr'));}
function resolveModel(root:string,requested=process.env.ASR_MODEL_PROFILE){
 const name=requested|| (existsSync(join(root,profiles['xasr-480'].subdirectory))?'xasr-480':'zipformer-small');
 if(!Object.hasOwn(profiles,name))throw new Error('ASR_MODEL_PROFILE 必须是 xasr-480 或 zipformer-small');
 const profile=profiles[name as LocalASRProfile];
 const modelDir=join(root,profile.subdirectory);
 const required=Object.values<string>(profile.files);
 if(name==='xasr-480')required.push('bpe.vocab');
 if(!required.every(file=>existsSync(join(modelDir,file)))){
  throw new Error(`${profile.label} 缺少本地语音模型文件，请运行模型下载脚本或重新安装完整应用。`);
 }
 return {profile,modelDir};
}
export function localASRAvailable():boolean {
 try{resolveModel(localModelDirectory());const require=createRequire(import.meta.url);require.resolve('sherpa-onnx-node');require.resolve(`sherpa-onnx-${process.platform==='win32'?'win':process.platform}-${process.arch}/sherpa-onnx.node`);return true;}catch{return false;}
}
type RecognizerProcess = {
  send(message: object, callback: (error: Error | null) => void): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};
type LocalOptions = {
  modelDir?: string;
  profile?: LocalASRProfile;
  hotwords?: readonly string[];
  spawnProcess?: (entry: string, options: ForkOptions) => RecognizerProcess;
  startupMs?: number;
  processingMs?: number;
  finishMs?: number;
};

function processOptions(): ForkOptions {
  // The decoder needs OS/runtime paths, but no service credentials or Node hooks.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return {
    execPath: process.versions.electron ? process.env.VC_ASR_EXEC_PATH || process.execPath : process.execPath,
    execArgv: [], env, serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  };
}

let activeProcesses = 0;
export function createLocalASR(callbacks: ASRCallbacks, options: LocalOptions = {}): ASRSession {
  const {profile, modelDir} = resolveModel(options.modelDir || localModelDirectory(), options.profile);
  if (activeProcesses >= 2) throw new Error('本机同时最多运行两路实时转写，请先停止另一场会议');
  const requested = localTranscriptionTerms(options.hotwords || [], profile.modelingUnit);
  const vocabularyMissing = requested.length > 0 && !existsSync(join(modelDir, 'bpe.vocab'));
  const hotwords = vocabularyMissing ? [] : requested;
  const entry = fileURLToPath(new URL('./local-worker.cjs', import.meta.url))
    .replace(/([\\/])app\.asar([\\/])dist([\\/])server([\\/])local-worker\.cjs$/, '$1app.asar.unpacked$2dist$3server$4local-worker.cjs');
  const child = (options.spawnProcess || ((entry, opts) => fork(entry, [], opts)))(entry, processOptions());
  activeProcesses++;

  const sessionId = randomUUID();
  let ready = false;
  let closed = false;
  let finishing = false;
  let finishSent = false;
  let done = false;
  let exited = false;
  let sequence = 0;
  let totalBytes = 0;
  let failure: Error | undefined;
  let finishPromise: Promise<void> | undefined;
  let resolveFinish: (() => void) | undefined;
  let rejectFinish: ((error: Error) => void) | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  const queued: {seq: number; pcm: Buffer}[] = [];
  const pending = new Map<number, {bytes: number; at: number}>();

  function cleanup() {
    clearTimeout(startTimer);
    clearInterval(watchdog);
    clearTimeout(finishTimer);
    queued.length = 0;
    pending.clear();
    totalBytes = 0;
  }
  function fail(error: Error) {
    if (closed) return;
    closed = true;
    failure = error;
    cleanup();
    if (!exited) child.kill('SIGKILL');
    rejectFinish?.(error);
    callbacks.onError(error);
  }
  function send(message: object) {
    const failed = () => fail(new Error('本地转写进程通信中断，请重新开始采集'));
    try {
      child.send(message, error => { if (error) failed(); });
    } catch { failed(); }
  }
  function flush() {
    if (!ready || closed) return;
    while (queued.length && !closed) {
      const frame = queued.shift()!;
      pending.set(frame.seq, {bytes: frame.pcm.length, at: Date.now()});
      send({type: 'audio', ...frame});
    }
    if (finishing && !finishSent && !closed) {
      finishSent = true;
      send({type: 'finish'});
    }
  }

  const startTimer = setTimeout(() => fail(new Error('本地转写模型启动超时，请检查模型文件和可用内存')), options.startupMs ?? 60000);
  const watchdog = setInterval(() => {
    for (const frame of pending.values()) {
      if (Date.now() - frame.at > (options.processingMs ?? 8000)) {
        fail(new Error('本地转写处理超时，已停止以避免音频持续积压'));
        break;
      }
    }
  }, 250);
  child.on('message', message => {
    if (closed || done) return;
    switch (message?.type) {
      case 'ready': {
        if (ready) return;
        ready = true;
        clearTimeout(startTimer);
        const note = vocabularyMissing ? '，当前模型缺少术语词表，已使用普通转写' : hotwords.length ? `，已参考 ${hotwords.length} 个术语` : '';
        callbacks.onStatus(`本地实时转写已就绪 · ${profile.label}（中文 / English，音频留在本机）` + note);
        if (!closed) callbacks.onReady?.();
        flush();
        break;
      }
      case 'ack': {
        const frame = pending.get(message.seq);
        if (frame) {
          totalBytes -= frame.bytes;
          pending.delete(message.seq);
        }
        break;
      }
      case 'segment': {
        const s = message.segment;
        if (!s || !Number.isInteger(s.index) || s.index < 0 || typeof s.text !== 'string' || s.text.length > 20000 ||
          typeof s.final !== 'boolean' || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs) || s.startMs < 0 || s.endMs < s.startMs) {
          fail(new Error('本地转写返回无效结果'));
          return;
        }
        if (s.text.trim()) callbacks.onSegment({
          id: `local:${sessionId}:${s.index}`, text: s.text, speaker: '发言者（本地未分离）',
          startMs: s.startMs, endMs: s.endMs, final: s.final, receivedAt: Date.now(), source: 'asr',
        });
        break;
      }
      case 'done':
        if (!finishSent || pending.size) return fail(new Error('本地转写仍有未确认音频，请核对末尾记录'));
        done = true;
        break;
      case 'error':
        fail(new Error(`${profile.label} 本地转写引擎运行失败，请检查模型、原生运行库和可用内存`));
        break;
    }
  });
  child.on('error', () => fail(new Error(`${profile.label} 本地转写进程启动或运行失败，请检查安装是否完整`)));
  // close also fires when spawn fails before there is a PID. Keep the slot
  // reserved until the child has really exited, including after cancellation.
  child.on('close', (code, signal) => {
    if (exited) return;
    exited = true;
    activeProcesses--;
    if (closed) return;
    if (!done || code !== 0) {
      fail(new Error(`本地转写进程意外退出（${signal || code || '未完成'}），请重新开始采集并核对记录`));
      return;
    }
    closed = true;
    cleanup();
    resolveFinish?.();
    callbacks.onStatus('本地实时转写已完成');
  });
  send({type: 'init', modelDir, modelType: profile.modelType, modelingUnit: profile.modelingUnit, files: profile.files, numThreads: 2, hotwords});

  if (failure) throw failure;

  return {
    write(pcm) {
      if (closed || finishing) throw failure ?? new Error('本地转写已关闭');
      if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 32000) throw new Error('本地转写需要 16kHz 单声道 PCM16 音频');
      if (totalBytes + pcm.length > 160000) {
        const error = new Error('本地转写音频积压超过 5 秒，请停止后重新开始');
        fail(error);
        throw error;
      }
      totalBytes += pcm.length;
      queued.push({seq: sequence++, pcm: Buffer.from(pcm)});
      flush();
      if (failure) throw failure;
    },
    finish() {
      if (finishPromise) return finishPromise;
      if (closed) return failure ? Promise.reject(failure) : Promise.resolve();
      finishing = true;
      finishPromise = new Promise<void>((resolve, reject) => { resolveFinish = resolve; rejectFinish = reject; });
      finishTimer = setTimeout(() => fail(new Error('本地转写尾音处理超时，末尾音频可能缺失')), options.finishMs ?? 15000);
      flush();
      return finishPromise;
    },
    close() {
      if (closed) return;
      closed = true;
      failure = new Error('本地转写已取消');
      cleanup();
      rejectFinish?.(failure);
      child.kill('SIGKILL');
    },
  };
}
