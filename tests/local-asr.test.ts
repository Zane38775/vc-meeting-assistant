import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {existsSync,readFileSync,mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalASR,forkLocalASRProcess,localASRAvailable,LOCAL_MODEL_FILES} from '../server/providers/local';
import {getCapabilities,createASR} from '../server/providers/index';

class FakeWorker extends EventEmitter {sent:any[]=[];terminated=false;postMessage(value:any){this.sent.push(value);}terminate(){this.terminated=true;this.emit('exit',1);return Promise.resolve(1);}}
function files(){const dir=mkdtempSync(join(tmpdir(),'vc-local-asr-'));for(const name of LOCAL_MODEL_FILES)writeFileSync(join(dir,name),'fixture');return dir;}
const silentCallbacks={onSegment:()=>{},onStatus:()=>{},onError:()=>{}};

test('a complete X-ASR profile is preferred and preserves case and hyphens for its BPE',()=>{
 const dir=files(),xasr=join(dir,'xasr-480');
 const prior=process.env.ASR_MODEL_PROFILE,manual=process.env.ASR_HOTWORDS;
 delete process.env.ASR_MODEL_PROFILE;delete process.env.ASR_HOTWORDS;
 mkdirSync(xasr);
 for(const name of ['encoder.int8.onnx','decoder.onnx','joiner.int8.onnx','tokens.txt','bpe.vocab'])writeFileSync(join(xasr,name),'fixture');
 let data:any;
 try{
  createLocalASR(silentCallbacks,{modelDir:dir,hotwords:['home party','ACE-Step'],workerFactory:(_url,selection)=>{data=selection;return new FakeWorker();}}).close();
  assert.equal(data.modelType,'zipformer2');
  assert.equal(data.modelingUnit,'bpe');
  assert.equal(data.modelDir,xasr);
  assert.deepEqual(data.hotwords,['home party','ACE-Step']);
  writeFileSync(join(dir,'bpe.vocab'),'fixture');
  createLocalASR(silentCallbacks,{modelDir:dir,profile:'zipformer-small',hotwords:['home party','ACE-Step'],workerFactory:(_url,selection)=>{data=selection;return new FakeWorker();}}).close();
  assert.equal(data.modelType,'zipformer');
  assert.equal(data.modelDir,dir);
  assert.deepEqual(data.hotwords,['HOME PARTY','ACE STEP']);
 }finally{
  if(prior===undefined)delete process.env.ASR_MODEL_PROFILE;else process.env.ASR_MODEL_PROFILE=prior;
  if(manual===undefined)delete process.env.ASR_HOTWORDS;else process.env.ASR_HOTWORDS=manual;
  rmSync(dir,{recursive:true,force:true});
 }
});

test('an explicitly selected or incomplete X-ASR profile never starts the older model',()=>{
 const dir=files(),oldProfile=process.env.ASR_MODEL_PROFILE;
 delete process.env.ASR_MODEL_PROFILE;
 try{
  assert.throws(()=>createLocalASR(silentCallbacks,{modelDir:dir,profile:'xasr-480',workerFactory:()=>new FakeWorker()}).close(),/X-ASR.*缺少/);
  mkdirSync(join(dir,'xasr-480'));
  assert.throws(()=>createLocalASR(silentCallbacks,{modelDir:dir,workerFactory:()=>new FakeWorker()}).close(),/X-ASR.*缺少/);
  process.env.ASR_MODEL_PROFILE='unknown';
  assert.throws(()=>createLocalASR(silentCallbacks,{modelDir:dir,workerFactory:()=>new FakeWorker()}).close(),/ASR_MODEL_PROFILE/);
 }finally{
  if(oldProfile===undefined)delete process.env.ASR_MODEL_PROFILE;else process.env.ASR_MODEL_PROFILE=oldProfile;
  rmSync(dir,{recursive:true,force:true});
 }
});
test('local ASR is default and missing models never fall back to speech cloud',()=>{
 const old=process.env.ASR_PROVIDER,oldDir=process.env.ASR_MODEL_DIR;delete process.env.ASR_PROVIDER;process.env.ASR_MODEL_DIR=join(tmpdir(),'nonexistent-vc-model');
 try{assert.equal(localASRAvailable(),false);assert.equal(getCapabilities().asr,false);assert.throws(()=>createASR({onSegment:()=>{},onStatus:()=>{},onError:()=>{}}),/本地.*模型/);}finally{if(old===undefined)delete process.env.ASR_PROVIDER;else process.env.ASR_PROVIDER=old;if(oldDir===undefined)delete process.env.ASR_MODEL_DIR;else process.env.ASR_MODEL_DIR=oldDir;}
});
test('model installer rejects truncated and altered cached files before use',async()=>{
 const {verifyFile}=await import(new URL('../scripts/download-model.mjs',import.meta.url).href);const dir=mkdtempSync(join(tmpdir(),'vc-model-integrity-'));const path=join(dir,'sample');
 try{writeFileSync(path,'abc');await verifyFile(path,{bytes:3,sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'});await assert.rejects(verifyFile(path,{bytes:4,sha256:''}),/Size mismatch/);await assert.rejects(verifyFile(path,{bytes:3,sha256:'0'.repeat(64)}),/SHA256 mismatch/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('local ASR bounds unacknowledged audio and flushes queued frames before finish',async()=>{
 const dir=files(),worker=new FakeWorker(),errors:Error[]=[];const segments:any[]=[];
 const session=createLocalASR({onSegment:s=>segments.push(s),onStatus:()=>{},onError:e=>errors.push(e)},{modelDir:dir,workerFactory:()=>worker});
 try{session.write(Buffer.alloc(6400));assert.equal(worker.sent.length,0);const finished=session.finish();worker.emit('message',{type:'ready'});assert.equal(worker.sent[0].type,'audio');assert.equal(worker.sent[1].type,'finish');worker.emit('message',{type:'segment',segment:{index:0,text:'尾音',final:true,startMs:0,endMs:200}});worker.emit('message',{type:'done'});await finished;assert.equal(segments[0].final,true);assert.match(segments[0].speaker,/未分离/);assert.equal(worker.terminated,false);worker.emit('exit',0);assert.deepEqual(errors,[]);}finally{session.close();rmSync(dir,{recursive:true,force:true});}
});
test('local ASR reports overload once and rejects pending finish on cancel',async()=>{
 const dir=files(),worker=new FakeWorker(),errors:Error[]=[];
 const callbacks={onSegment:()=>{},onStatus:()=>{},onError:(e:Error)=>errors.push(e)};
 const session=createLocalASR(callbacks,{modelDir:dir,workerFactory:()=>worker});
 try{for(let i=0;i<26;i++)session.write(Buffer.alloc(6400));assert.equal(errors.length,1);assert.equal(worker.terminated,true);await assert.rejects(session.finish(),/积压/);
 const another=createLocalASR(callbacks,{modelDir:dir,workerFactory:()=>new FakeWorker()});const pending=another.finish();another.close();await assert.rejects(pending,/取消/);}finally{session.close();rmSync(dir,{recursive:true,force:true});}
});
test('local ASR startup deadline releases workers',async()=>{
 const dir=files(),worker=new FakeWorker();let resolve!:(e:Error)=>void;const error=new Promise<Error>(r=>resolve=r);
 const session=createLocalASR({onSegment:()=>{},onStatus:()=>{},onError:resolve},{modelDir:dir,workerFactory:()=>worker,startupMs:20});
 try{assert.match((await error).message,/启动超时/);await assert.rejects(session.ready!,/启动超时/);assert.equal(worker.terminated,true);}finally{session.close();rmSync(dir,{recursive:true,force:true});}
});
test('local ASR processing deadline terminates a stalled decoder with unacknowledged audio',async()=>{
 const dir=files(),worker=new FakeWorker();let resolve!:(e:Error)=>void;const error=new Promise<Error>(r=>resolve=r);
 const session=createLocalASR({onSegment:()=>{},onStatus:()=>{},onError:resolve},{modelDir:dir,workerFactory:()=>worker,processingMs:20});
 try{worker.emit('message',{type:'ready'});session.write(Buffer.alloc(6400));assert.match((await error).message,/处理超时/);assert.equal(worker.terminated,true);}finally{session.close();rmSync(dir,{recursive:true,force:true});}
});
test('native abort and configuration secrets are contained within the ASR child process',async()=>{
 const dir=files();
 const keys=['DEEPSEEK_API_KEY','TENCENT_SECRET_KEY','DOTENV_CONFIG_PATH','NODE_OPTIONS'];
 const saved=keys.map(key=>process.env[key]);
 const errors:Error[]=[];
 let reportError!:(error:Error)=>void;
 const crashed=new Promise<Error>(resolve=>{reportError=resolve;});
 let session:ReturnType<typeof createLocalASR>|undefined;
 const fixture=new URL('./fixtures/aborting-asr.cjs',import.meta.url);
 const workerFactory=(_url:URL,data:Parameters<typeof forkLocalASRProcess>[1])=>forkLocalASRProcess(fixture,data);
 try{
  keys.forEach(key=>{process.env[key]='test-only-secret';});
  try{
   session=createLocalASR({...silentCallbacks,onError:error=>{errors.push(error);reportError(error);}},{
    modelDir:dir,profile:'zipformer-small',workerFactory,
   });
  }finally{
   keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});
  }
  await session.ready;
  session.write(Buffer.alloc(6400));
  const error=await crashed;
  const exit=process.platform==='win32'?/本地转写子进程意外退出（-?[1-9][0-9]*）/:/本地转写子进程意外退出（SIGABRT）/;
  assert.match(error.message,exit);
  await assert.rejects(session.finish(),{message:error.message});
  assert.deepEqual(errors,[error]);

  const replacement=createLocalASR(silentCallbacks,{modelDir:dir,profile:'zipformer-small',workerFactory});
  try{
   await replacement.ready;
   await replacement.finish();
  }finally{replacement.close();}
 }finally{session?.close();rmSync(dir,{recursive:true,force:true});}
});
test('closing during actual X-ASR startup leaves the caller alive and able to open another session',{
 skip:!existsSync('models/local-asr/xasr-480/encoder.int8.onnx'),
},async()=>{
 const fixture=fileURLToPath(new URL('./fixtures/cancel-asr-and-reopen.mjs',import.meta.url));
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx/esm',fixture],{timeout:30000});
 assert.match(stdout,/reopened after startup cancellation/);
});
test('local ASR child transcribes bundled real bilingual WAV with partials and final tail', {skip:!existsSync('models/local-asr/test_wavs/0.wav')},async()=>{
 const wav=readFileSync('models/local-asr/test_wavs/0.wav');let at=12,pcm:Buffer|undefined;
 while(at+8<=wav.length){const size=wav.readUInt32LE(at+4);if(wav.toString('ascii',at,at+4)==='data'){pcm=wav.subarray(at+8,at+8+size);break;}at+=8+size+(size%2);}
 assert.ok(pcm);const segments:any[]=[];const errors:Error[]=[];let ready!:()=>void;const started=new Promise<void>(r=>ready=r);
 const session=createLocalASR({onSegment:s=>segments.push(s),onStatus:s=>{if(s.includes('已就绪'))ready();},onError:e=>errors.push(e)},{profile:'zipformer-small'});
 let heartbeats=0;const heartbeat=setInterval(()=>heartbeats++,10);const begin=Date.now();
 try{await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('startup wait exceeded')),20000).unref())]);for(let i=0;i<pcm.length;i+=6400){session.write(pcm.subarray(i,i+6400));await new Promise(r=>setTimeout(r,40));}await session.finish();const final=segments.filter(s=>s.final).map(s=>s.text).join(' ');assert.match(final,/昨天|星期/);assert.match(final,/MONDAY|TODAY|TOMORROW/i);assert.ok(segments.some(s=>!s.final));assert.ok(heartbeats>10);assert.deepEqual(errors,[]);console.log(JSON.stringify({localASRActual:{durationSeconds:pcm.length/32000,elapsedMs:Date.now()-begin,partialCount:segments.filter(s=>!s.final).length,final,heartbeats}}));}finally{clearInterval(heartbeat);session.close();}
});
test('X-ASR streams real bilingual audio with its own vocabulary and finalizes the tail',{
 skip:!existsSync('models/local-asr/xasr-480/encoder.int8.onnx')||!existsSync('models/local-asr/test_wavs/0.wav'),
},async()=>{
 const wav=readFileSync('models/local-asr/test_wavs/0.wav');let pcm:Buffer|undefined;
 for(let at=12;at+8<=wav.length;){
  const size=wav.readUInt32LE(at+4);
  if(wav.toString('ascii',at,at+4)==='data'){pcm=wav.subarray(at+8,at+8+size);break;}
  at+=8+size+(size%2);
 }
 assert.ok(pcm);
 const segments:Array<{text:string;final:boolean}>=[];
 const errors:Error[]=[];
 let resolve!:(status:string)=>void;
 let reject!:(error:Error)=>void;
 const started=new Promise<string>((onReady,onError)=>{resolve=onReady;reject=onError;});
 const session=createLocalASR({
  onSegment:segment=>segments.push(segment),
  onStatus:status=>{if(status.includes('已就绪'))resolve(status);},
  onError:error=>{errors.push(error);reject(error);},
 },{profile:'xasr-480',hotwords:['Monday']});
 try{
  assert.match(await started,/X-ASR 480 ms.*已参考/);
  for(let offset=0;offset<pcm.length;offset+=6400){
   session.write(pcm.subarray(offset,offset+6400));
   await new Promise(resolve=>setTimeout(resolve,80));
  }
  await session.finish();
  assert.deepEqual(errors,[]);
  assert.ok(segments.some(segment=>!segment.final));
  const final=segments.filter(segment=>segment.final).map(segment=>segment.text).join(' ');
  assert.match(final,/Monday/i);
  assert.match(final,/Tomorrow/i);
  assert.match(final,/星期三/);
 }finally{session.close();}
});
test('local worker real-time 200ms pacing measures bilingual and Chinese partial/final latency',{skip:process.env.RUN_LOCAL_ASR_REALTIME!=='1'},async()=>{
 for(const sample of ['0','1']){
  const wav=readFileSync(`models/local-asr/test_wavs/${sample}.wav`);let at=12,pcm:Buffer|undefined;
  while(at+8<=wav.length){const size=wav.readUInt32LE(at+4);if(wav.toString('ascii',at,at+4)==='fmt '){assert.equal(wav.readUInt16LE(at+10),1);assert.equal(wav.readUInt32LE(at+12),16000);assert.equal(wav.readUInt16LE(at+22),16);}if(wav.toString('ascii',at,at+4)==='data'){pcm=wav.subarray(at+8,at+8+size);break;}at+=8+size+(size%2);}
  assert.ok(pcm);const segments:any[]=[];const errors:Error[]=[];const created=performance.now();let ready!:()=>void,firstPartial=0,lastFinal=0;
  const started=new Promise<void>(r=>ready=r);
  const session=createLocalASR({onSegment:s=>{segments.push(s);if(!s.final&&!firstPartial)firstPartial=performance.now();if(s.final)lastFinal=performance.now();},onStatus:s=>{if(s.includes('已就绪'))ready();},onError:e=>errors.push(e)});
  try{await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('startup wait exceeded')),20000).unref())]);const startupMs=performance.now()-created;const audioStart=performance.now();let firstWrite=0,lastWrite=0;
   for(let i=0;i<pcm.length;i+=6400){const bytes=Math.min(6400,pcm.length-i);await new Promise(r=>setTimeout(r,Math.max(0,audioStart+(i+bytes)/32-performance.now())));if(!firstWrite)firstWrite=performance.now();session.write(pcm.subarray(i,i+bytes));lastWrite=performance.now();}
   await session.finish();assert.deepEqual(errors,[]);assert.ok(firstPartial);assert.ok(lastFinal);const final=segments.filter(s=>s.final).map(s=>s.text).join(' ');assert.ok(final.length>2);
   console.log(JSON.stringify({localASRRealtime:{sample:`test_wavs/${sample}.wav`,durationSeconds:pcm.length/32000,startupMs:Math.round(startupMs),firstPartialFromAudioStartMs:Math.round(firstPartial-audioStart),firstPartialFromFirstFrameMs:Math.round(firstPartial-firstWrite),finalizationAfterLastFrameMs:Math.round(lastFinal-lastWrite),finishCompletedAfterLastFrameMs:Math.round(performance.now()-lastWrite),partialCount:segments.filter(s=>!s.final).length,final}}));
  }finally{session.close();}
 }
});
test('local worker finalizes natural pause and continues a second utterance with distinct stable IDs',{skip:!existsSync('models/local-asr/test_wavs/0.wav')},async()=>{
 const readPCM=(sample:string)=>{const wav=readFileSync(`models/local-asr/test_wavs/${sample}.wav`);let at=12;while(at+8<=wav.length){const size=wav.readUInt32LE(at+4);if(wav.toString('ascii',at,at+4)==='data')return wav.subarray(at+8,at+8+size);at+=8+size+(size%2);}throw new Error('WAV data missing');};
 const segments:any[]=[],errors:Error[]=[];let ready!:()=>void;const started=new Promise<void>(r=>ready=r);
 const session=createLocalASR({onSegment:s=>segments.push(s),onStatus:s=>{if(s.includes('已就绪'))ready();},onError:e=>errors.push(e)},{profile:'zipformer-small'});
 const feed=async(pcm:Buffer)=>{for(let i=0;i<pcm.length;i+=6400){session.write(pcm.subarray(i,i+6400));await new Promise(r=>setTimeout(r,40));}};
 try{await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error('startup wait exceeded')),20000).unref())]);await feed(readPCM('0'));await feed(Buffer.alloc(32000*2));assert.ok(segments.some(s=>s.final),'natural pause must finalize before finish');await feed(readPCM('1'));await session.finish();const finals=segments.filter(s=>s.final);assert.ok(finals.length>=2);assert.equal(new Set(finals.map(s=>s.id)).size,finals.length);assert.ok(finals[1].startMs>=finals[0].endMs);for(const final of finals)assert.ok(segments.some(s=>!s.final&&s.id===final.id));assert.deepEqual(errors,[]);}finally{session.close();}
});
