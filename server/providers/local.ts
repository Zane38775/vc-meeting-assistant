import type {ASRSession,ASRCallbacks} from './contracts';
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
export const LOCAL_MODEL_FILES=['encoder-epoch-99-avg-1.int8.onnx','decoder-epoch-99-avg-1.onnx','joiner-epoch-99-avg-1.int8.onnx','tokens.txt'];
export function localModelDirectory():string {return resolve(process.env.ASR_MODEL_DIR||join((process as NodeJS.Process&{resourcesPath?:string}).resourcesPath||process.cwd(),'models','local-asr'));}
export function localASRAvailable():boolean {
 if(!LOCAL_MODEL_FILES.every(name=>existsSync(join(localModelDirectory(),name))))return false;
 try{const require=createRequire(import.meta.url);require.resolve('sherpa-onnx-node');require.resolve(`sherpa-onnx-${process.platform==='win32'?'win':process.platform}-${process.arch}/sherpa-onnx.node`);return true;}catch{return false;}
}
interface WorkerChannel {postMessage(value:any,transferList?:ArrayBuffer[]):void;on(event:string,listener:(...args:any[])=>void):unknown;terminate():Promise<number>}
let activeWorkers=0;
export function createLocalASR(callbacks:ASRCallbacks,options:{modelDir?:string;workerFactory?:(url:URL,data:any)=>WorkerChannel;startupMs?:number;processingMs?:number;finishMs?:number}={}):ASRSession {
 const modelDir=options.modelDir||localModelDirectory();
 if(!LOCAL_MODEL_FILES.every(name=>existsSync(join(modelDir,name))))throw new Error('本地语音模型缺失，请运行模型下载脚本或重新安装完整应用');
 if(activeWorkers>=2)throw new Error('本机同时最多运行两路实时转写，请先停止另一场会议');
 const workerURL=new URL('./local-worker.cjs',import.meta.url);
 const workerData={modelDir,numThreads:2};
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
  if(message?.type==='ready'){ready=true;clearTimeout(startTimer);callbacks.onStatus('本地实时转写已就绪（中文 / English，音频留在本机）');send();}
  else if(message?.type==='ack'){const item=pending.get(message.seq);if(item){totalBytes-=item.bytes;pending.delete(message.seq);}}
  else if(message?.type==='segment'){
   const s=message.segment;
   if(!s||!Number.isInteger(s.index)||s.index<0||typeof s.text!=='string'||s.text.length>20000||typeof s.final!=='boolean'||!Number.isFinite(s.startMs)||!Number.isFinite(s.endMs)||s.startMs<0||s.endMs<s.startMs)return fail(new Error('本地转写返回无效结果'));
   if(s.text.trim())callbacks.onSegment({id:`local:${sessionId}:${s.index}`,text:s.text,speaker:'发言者（本地未分离）',startMs:s.startMs,endMs:s.endMs,final:s.final,receivedAt:Date.now(),source:'asr'});
  }else if(message?.type==='done'){closed=true;cleanup();resolveFinish?.();terminate();callbacks.onStatus('本地实时转写已完成');}
  else if(message?.type==='error')fail(new Error('本地转写引擎运行失败，请检查模型、原生运行库和可用内存'));
 });
 worker.on('error',()=>fail(new Error('本地转写工作线程启动或运行失败，请检查安装是否完整')));
 worker.on('exit',()=>{release();if(!closed)fail(new Error('本地转写线程意外退出，末尾音频可能缺失'));});
 return {
  write(pcm){if(closed||ending)throw failure??new Error('本地转写已关闭');if(!Buffer.isBuffer(pcm)||!pcm.length||pcm.length%2||pcm.length>32000)throw new Error('本地转写需要 16kHz 单声道 PCM16 音频');if(totalBytes+pcm.length>160000){fail(new Error('本地转写音频积压超过 5 秒，请停止后重新开始'));return;}const data=Uint8Array.from(pcm);totalBytes+=data.byteLength;queued.push({seq:sequence++,pcm:data.buffer});send();},
  finish(){if(finishPromise)return finishPromise;if(closed)return failure?Promise.reject(failure):Promise.resolve();ending=true;finishPromise=new Promise<void>((resolve,reject)=>{resolveFinish=resolve;rejectFinish=reject;});finishTimer=setTimeout(()=>fail(new Error('本地转写尾音处理超时，末尾音频可能缺失')),options.finishMs??15000);send();return finishPromise;},
  close(){if(closed)return;closed=true;failure=new Error('本地转写已取消');cleanup();rejectFinish?.(failure);terminate();}
 };
}
