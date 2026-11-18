import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync, build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {StreamingPcmEncoder, mixAndMeasure} from '../client/audio-core.ts';

test('48 kHz samples become exactly one 200ms PCM16LE frame without block loss', () => {
  const frames: Uint8Array[] = [];
  const encoder = new StreamingPcmEncoder(48000, frame => frames.push(frame));
  for (let i = 0; i < 74; i++) encoder.push(new Float32Array(128).fill(0.5));
  assert.equal(frames.length, 0);
  encoder.push(new Float32Array(128).fill(0.5));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 6400);
  assert.equal(new DataView(frames[0].buffer).getInt16(0, true), 16384);
  assert.equal(new DataView(frames[0].buffer).getInt16(6398, true), 16384);
});

test('44.1 kHz conversion stays continuous across irregular chunks without drift', () => {
  const signal = Float32Array.from({length:44100 * 7}, (_, i) => Math.sin(i * 0.1) * 0.7);
  const all: Uint8Array[] = [], split: Uint8Array[] = [];
  new StreamingPcmEncoder(44100, b => all.push(b)).push(signal);
  const encoder = new StreamingPcmEncoder(44100, b => split.push(b));
  for (let i = 0; i < signal.length; i += 137) encoder.push(signal.subarray(i, i + 137));
  assert.equal(split.length, 35);
  assert.deepEqual(split, all);
});

test('PCM encoding clips signed values and emits little-endian bytes', () => {
  const frames: Uint8Array[] = [];
  const encoder = new StreamingPcmEncoder(16000, b => frames.push(b));
  encoder.push(Float32Array.from([-2, 2, -0.5, 0.5, Number.NaN]));
  encoder.flush();
  assert.deepEqual([...frames[0].slice(0, 10)], [0,128,255,127,0,192,0,64,0,0]);
  assert.equal(frames[0].length, 6400);
  assert.ok(frames[0].slice(10).every(v => v === 0));
  encoder.flush();
  assert.equal(frames.length, 1);
});

test('discarding partial audio on pause prevents pre-pause samples in resumed frames', () => {
  const frames: Uint8Array[] = [];
  const encoder = new StreamingPcmEncoder(44100, b => frames.push(b));
  encoder.push(new Float32Array(100).fill(1));
  encoder.reset();
  encoder.push(new Float32Array(8820).fill(-1));
  assert.equal(frames.length, 1);
  const view = new DataView(frames[0].buffer);
  for (let i = 0; i < 6400; i += 2) assert.equal(view.getInt16(i, true), -32768);
});

test('source meters use actual source samples and stereo is reduced to mono', () => {
  const mic = [Float32Array.from([0.5, -0.5]), Float32Array.from([0.5, -0.5])];
  const system = [Float32Array.from([0.25, 0.25])];
  const result = mixAndMeasure(mic, system, 2);
  assert.equal(result.mic, 0.5);
  assert.equal(result.system, 0.25);
  assert.deepEqual([...result.samples], [0.75, -0.25]);
  assert.equal(mixAndMeasure(mic, [], 2).system, 0);
});

function workletHarness(startPaused = false) {
  const messages: any[] = [];
  let Processor: any;
  const code = buildSync({entryPoints:[fileURLToPath(new URL('../client/pcm-worklet.js', import.meta.url))], bundle:true, write:false, format:'iife'}).outputFiles[0].text;
  const scope = {sampleRate:48000, currentTime:0, AudioWorkletProcessor: class {
    port = {onmessage: null as any, postMessage(message: any) {messages.push(message);}};
  }, registerProcessor(_name: string, implementation: any) { Processor = implementation; }};
  runInNewContext(code, scope);
  const processor = new Processor({processorOptions:{startPaused}});
  return {messages, processor, render(count:number) {for(let i=0;i<count;i++) {scope.currentTime += 128/48000; processor.process([[new Float32Array(128).fill(0.5)],[]], [[new Float32Array(128)]]);}}};
}

test('worklet flushes final speech on stop and emits no more audio afterwards', () => {
  const {processor, messages, render} = workletHarness();
  render(30);
  processor.port.onmessage({data:{type:'stop'}});
  assert.equal(messages.filter(m => m.type === 'frame').length, 1);
  assert.equal(messages.at(-1).type, 'stopped');
  render(100);
  assert.equal(messages.filter(m => m.type === 'frame').length, 1);
});

test('worklet discards warmup samples without encoding or queueing them', () => {
  const {processor, messages, render} = workletHarness(true);
  render(1950); // 5.2 seconds at 48 kHz, 128 samples per processing quantum
  assert.equal(messages.length, 0);
  processor.port.onmessage({data:{type:'resume'}});
  render(75);
  assert.equal(messages.filter(m => m.type === 'frame').length, 1);
  assert.equal(messages.some(m => m.type === 'error'), false);
});

test('worklet bounds undelivered audio instead of queuing endlessly on a blocked renderer', () => {
  const {messages, render} = workletHarness();
  render(75 * 10);
  assert.ok(messages.filter(m => m.type === 'frame').length <= 5);
  assert.equal(messages.filter(m => m.type === 'error').length, 1);
});

test('desktop permits only timely main-frame audio capture on its exact configured origin', () => {
  const {canRequestCapture, parseServerUrl} = createRequire(import.meta.url)('../desktop/main.cjs');
  const request = {origin:'http://127.0.0.1:4318/meeting',targetOrigin:'http://127.0.0.1:4318',topFrame:true,armedUntil:2000,now:1000,mode:'online',permission:'media',mediaTypes:['audio']};
  assert.equal(canRequestCapture(request), true);
  for (const change of [{topFrame:false},{armedUntil:0},{origin:'http://127.0.0.1:4319'},{origin:'https://malicious.example'},{mediaTypes:['video']},{mediaTypes:['audio','video']},{permission:'clipboard-read'}]) {
    assert.equal(canRequestCapture({...request,...change}), false);
  }
  assert.equal(canRequestCapture({...request,permission:'display-capture'}), true);
  assert.equal(canRequestCapture({...request,permission:'display-capture',mode:'offline'}), false);
  assert.throws(() => parseServerUrl('http://example.com'));
  assert.throws(() => parseServerUrl('https://user:secret@example.com'));
  assert.equal(parseServerUrl().origin, 'http://127.0.0.1:4318');
});

test('macOS system audio needs CoreAudio Tap support from 14.2 and later', () => {
  const {supportsLoopback} = createRequire(import.meta.url)('../desktop/main.cjs');
  assert.equal(supportsLoopback('darwin','14.1.2'),false);
  assert.equal(supportsLoopback('darwin','14.2'),true);
  assert.equal(supportsLoopback('darwin','15.0.1'),true);
  assert.equal(supportsLoopback('darwin','unknown'),false);
  assert.equal(supportsLoopback('win32','10.0'),true);
  assert.equal(supportsLoopback('linux','6.8'),false);
});

test('desktop original-material downloads allow only exact authenticated-origin UUID file endpoints', () => {
  const {allowedMaterialFileUrl} = createRequire(import.meta.url)('../desktop/main.cjs');
  const origin='http://127.0.0.1:4318';
  const file='/api/materials/632bb486-56ed-4d92-9b7c-43830888a610/file';
  assert.equal(allowedMaterialFileUrl(origin+file,origin),true);
  for(const url of [
    'https://evil.example'+file, 'http://127.0.0.1:4319'+file,
    'http://user:password@127.0.0.1:4318'+file, origin+'/api/projects',
    origin+'/api/materials/not-a-uuid/file',origin+file+'/extra',origin+file+'?redirect=https://evil.example',
    origin+file+'#script',origin+file.replace('/file','/%66ile'),'javascript:alert(1)',file,
  ]) assert.equal(allowedMaterialFileUrl(url,origin),false,url);
});

async function captureHarness(mediaDevices: object, active = true, browser: object = {}) {
  const result = await build({entryPoints:[fileURLToPath(new URL('../client/audio.ts', import.meta.url))],bundle:true,write:false,format:'cjs',plugins:[{
    name:'worklet-asset', setup(build) {
      build.onResolve({filter:/\?worker&url$/}, () => ({path:'worklet',namespace:'test-asset'}));
      build.onLoad({filter:/.*/,namespace:'test-asset'}, () => ({contents:'export default "/worklet.js";'}));
    },
  }]});
  const scope = {module:{exports:{} as any}, navigator:{userActivation:{isActive:active},mediaDevices},
    window:{AudioContext:class {}}, performance, setTimeout, clearTimeout, setInterval, clearInterval, console, ...browser};
  runInNewContext(result.outputFiles[0].text, scope);
  return scope.module.exports.captureAudio;
}
const captureCallbacks = {onChunk:()=>{},onLevels:()=>{},onError:()=>{}};
function fakeStream(audio = true) {
  const track = {kind:audio?'audio':'video',readyState:'live',stop() {this.readyState='ended';},addEventListener(){},removeEventListener(){}};
  return {track,getTracks:()=>[track],getAudioTracks:()=>audio?[track]:[]};
}

test('capture never requests a microphone without a fresh user gesture', async () => {
  let requested = false;
  const capture = await captureHarness({getUserMedia(){requested=true;}},false);
  await assert.rejects(capture({mode:'offline',...captureCallbacks}), /点击/);
  assert.equal(requested,false);
});

test('missing display audio rejects online start and releases microphone and display tracks', async () => {
  const mic = fakeStream(), screen = fakeStream(false);
  const capture = await captureHarness({getUserMedia:async()=>mic,getDisplayMedia:async()=>screen});
  await assert.rejects(capture({mode:'online',...captureCallbacks}), /系统音频没有可用音轨/);
  assert.equal(mic.track.readyState,'ended');
  assert.equal(screen.track.readyState,'ended');
});

test('microphone permission resolving after display rejection is released immediately', async () => {
  let grant!: (stream: unknown) => void;
  const mic = fakeStream();
  const capture = await captureHarness({getUserMedia:()=>new Promise(resolve=>{grant=resolve;}),getDisplayMedia:async()=>{throw new Error('display denied');}});
  await assert.rejects(capture({mode:'online',...captureCallbacks}), /display denied/);
  grant(mic);
  await new Promise(resolve => setTimeout(resolve,0));
  assert.equal(mic.track.readyState,'ended');
});

test('cancelling device selection releases an acquired microphone and later screen permission', async () => {
  const mic = fakeStream(), screen = fakeStream();
  let grantScreen!: (stream: unknown) => void;
  const controller = new AbortController();
  const capture = await captureHarness({getUserMedia:async()=>mic, getDisplayMedia:()=>new Promise(resolve=>{grantScreen=resolve;})});
  const pending = capture({mode:'online',signal:controller.signal,startPaused:true,...captureCallbacks});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((mic.track as typeof mic.track & {enabled:boolean}).enabled, false);
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(mic.track.readyState, 'ended');
  grantScreen(screen);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(screen.track.readyState, 'ended');
});

async function activeCapture() {
  const mic = fakeStream();
  const frames: string[] = [];
  const messages: string[] = [];
  let receive: (data: object) => void = () => {};
  class Context {
    state = 'running';
    currentTime = 1;
    destination = {};
    audioWorklet = {addModule: async () => {}};
    async resume() {}
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return {connect() {}, disconnect() {}}; }
  }
  class Worklet {
    port = {
      onmessage: null as ((event: {data: object}) => void) | null,
      postMessage: (message: {type: string}) => messages.push(message.type),
      close() {},
    };
    constructor() { receive = data => this.port.onmessage?.({data}); }
    connect() {}
    disconnect() {}
  }
  let expire: () => void = () => {};
  const capture = await captureHarness({getUserMedia: async () => mic}, true, {
    window: {AudioContext: Context},
    AudioContext: Context,
    AudioWorkletNode: Worklet,
    MediaStream: class {},
    btoa,
    setTimeout(fn: () => void) { expire = fn; return 1; },
    clearTimeout() {},
  });
  const handle = await capture({mode: 'offline', ...captureCallbacks, onChunk: ({pcm}: {pcm: string}) => frames.push(pcm)});
  return {handle, mic, messages, frames, receive, expire: () => expire()};
}

test('stop forwards the tail frame before accepting a delayed worklet confirmation', async () => {
  const fixture = await activeCapture();
  const stopping = fixture.handle.stop();
  let finished = false;
  void stopping.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  fixture.receive({type: 'frame', pcm: Uint8Array.of(1, 0).buffer, at: 1});
  fixture.receive({type: 'stopped'});
  await stopping;
  assert.deepEqual(fixture.frames, ['AQA=']);
  assert.deepEqual(fixture.messages, ['stop', 'ack']);
  assert.equal(fixture.mic.track.readyState, 'ended');
});

test('stop rejects when a suspended worklet cannot confirm the tail', async () => {
  const fixture = await activeCapture();
  const stopping = fixture.handle.stop();
  fixture.expire();
  await assert.rejects(stopping, /最后一段音频.*超时/);
  assert.equal(fixture.mic.track.readyState, 'ended');
});

test('a worklet error during stop is visible even when a stopped message follows', async () => {
  const fixture = await activeCapture();
  const stopping = fixture.handle.stop();
  fixture.receive({type: 'error', message: '音频处理落后超过 1 秒'});
  fixture.receive({type: 'stopped'});
  await assert.rejects(stopping, /音频处理落后/);
  assert.equal(fixture.mic.track.readyState, 'ended');
});
