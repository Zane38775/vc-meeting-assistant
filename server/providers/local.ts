import type {ASRSession,ASRCallbacks} from './contracts';
import {Worker} from 'node:worker_threads';
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
interface WorkerChannel {postMessage(value:any,transferList?:ArrayBuffer[]):void;on(event:string,listener:(...args:any[])=>void):unknown;terminate():Promise<number>}
let activeWorkers=0;
export function createLocalASR(callbacks:ASRCallbacks,options:{modelDir?:string;profile?:LocalASRProfile;hotwords?:readonly string[];workerFactory?:(url:URL,data:any)=>WorkerChannel;startupMs?:number;processingMs?:number;finishMs?:number}={}):ASRSession {
 const {profile,modelDir}=resolveModel(options.modelDir||localModelDirectory(),options.profile);
 if(activeWorkers>=2)throw new Error('本机同时最多运行两路实时转写，请先停止另一场会议');
 const workerURL=new URL('./local-worker.cjs',import.meta.url);
 const requestedHotwords=localTranscriptionTerms(options.hotwords||[],profile.modelingUnit);
 const vocabularyMissing=requestedHotwords.length>0&&!existsSync(join(modelDir,'bpe.vocab'));
 const hotwords=vocabularyMissing?[]:requestedHotwords;
 const workerData={modelDir,modelType:profile.modelType,modelingUnit:profile.modelingUnit,files:profile.files,numThreads:2,hotwords};
 const worker=options.workerFactory?options.workerFactory(workerURL,workerData):new Worker(workerURL,{workerData,resourceLimits:{maxOldGenerationSizeMb:128}});
 activeWorkers++;
 const sessionId=randomUUID();let ready=false,closed=false,ending=false,finishSent=false,sequence=0,totalBytes=0,released=false;
 let failure:Error|undefined,finishPromise:Promise<void>|undefined,resolveFinish:(()=>void)|undefined,rejectFinish:((e:Error)=>void)|undefined,finishTimer:ReturnType<typeof setTimeout>|undefined;
 const queued:{seq:number;pcm:ArrayBuffer}[]=[];const pending=new Map<number,{bytes:number;at:number}>();
 const release=()=>{if(!released){released=true;activeWorkers--;}};
 const cleanup=()=>{clearTimeout(startTimer);clearInterval(watchdog);if(finishTimer)clearTimeout(finishTimer);queued.length=0;pending.clear();totalBytes=0;};
 const terminate=()=>{void worker.terminate().finally(release);};
 const fail=(e:Error)=>{if(closed)return;closed=true;failure=e;cleanup();rejectFinish?.(e);terminate();callbacks.onError(e);};
 const send=()=>{if(!ready||closed)return;for(const frame of queued.splice(0)){const bytes=frame.pcm.byteLength;pending.set(frame.seq,{bytes,at:Date.now()});worker.postMessage({type:'audio',...frame},[frame.pcm]);}if(ending&&!finishSent){finishSent=true;worker.postMessage({type:'finish'});}};
 const startTimer=setTimeout(()=>fail(new Error('本地转写模型启动超时，请检查模型文件和可用内存')),options.startupMs??20000);
 const watchdog=setInterval(()=>{if([...pending.values()].some(item=>Date.now()-item.at>(options.processingMs??8000)))fail(new Error('本地转写处理超时，已停止以避免音频持续积压'));},250);
 worker.on('message',(message:any)=>{
  if(closed)return;
  if(message?.type==='ready'){
   ready=true;clearTimeout(startTimer);
   const note=vocabularyMissing?'，当前模型缺少术语词表，已使用普通转写':hotwords.length?`，已参考 ${hotwords.length} 个术语`:'';
   callbacks.onStatus(`本地实时转写已就绪 · ${profile.label}（中文 / English，音频留在本机）`+note);
   send();
  }
  else if(message?.type==='ack'){const item=pending.get(message.seq);if(item){totalBytes-=item.bytes;pending.delete(message.seq);}}
  else if(message?.type==='segment'){
   const s=message.segment;
   if(!s||!Number.isInteger(s.index)||s.index<0||typeof s.text!=='string'||s.text.length>20000||typeof s.final!=='boolean'||!Number.isFinite(s.startMs)||!Number.isFinite(s.endMs)||s.startMs<0||s.endMs<s.startMs)return fail(new Error('本地转写返回无效结果'));
   if(s.text.trim())callbacks.onSegment({id:`local:${sessionId}:${s.index}`,text:s.text,speaker:'发言者（本地未分离）',startMs:s.startMs,endMs:s.endMs,final:s.final,receivedAt:Date.now(),source:'asr'});
  }else if(message?.type==='done'){closed=true;cleanup();resolveFinish?.();terminate();callbacks.onStatus('本地实时转写已完成');}
  else if(message?.type==='error')fail(new Error(`${profile.label} 本地转写引擎运行失败，请检查模型、原生运行库和可用内存`));
 });
 worker.on('error',()=>fail(new Error(`${profile.label} 本地转写工作线程启动或运行失败，请检查安装是否完整`)));
 worker.on('exit',()=>{release();if(!closed)fail(new Error('本地转写线程意外退出，末尾音频可能缺失'));});
 return {
  write(pcm){if(closed||ending)throw failure??new Error('本地转写已关闭');if(!Buffer.isBuffer(pcm)||!pcm.length||pcm.length%2||pcm.length>32000)throw new Error('本地转写需要 16kHz 单声道 PCM16 音频');if(totalBytes+pcm.length>160000){fail(new Error('本地转写音频积压超过 5 秒，请停止后重新开始'));return;}const data=Uint8Array.from(pcm);totalBytes+=data.byteLength;queued.push({seq:sequence++,pcm:data.buffer});send();},
  finish(){if(finishPromise)return finishPromise;if(closed)return failure?Promise.reject(failure):Promise.resolve();ending=true;finishPromise=new Promise<void>((resolve,reject)=>{resolveFinish=resolve;rejectFinish=reject;});finishTimer=setTimeout(()=>fail(new Error('本地转写尾音处理超时，末尾音频可能缺失')),options.finishMs??15000);send();return finishPromise;},
  close(){if(closed)return;closed=true;failure=new Error('本地转写已取消');cleanup();rejectFinish?.(failure);terminate();}
 };
}
