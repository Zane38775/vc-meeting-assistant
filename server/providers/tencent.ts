import {createHmac,randomInt,randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import type {Segment} from '../../shared/types';
import type {ASRCallbacks,ASRSession} from './contracts';

/** Protocol: https://cloud.tencent.com/document/product/1093/131127 */
export interface TencentConfig {appId:string;secretId:string;secretKey:string;engine:string}
export function tencentConfig():TencentConfig {
 return {appId:process.env.TENCENT_APP_ID||'',secretId:process.env.TENCENT_SECRET_ID||'',secretKey:process.env.TENCENT_SECRET_KEY||'',engine:process.env.TENCENT_ENGINE_MODEL||'16k_zh_en_speaker_2.0'};
}
export function signTencentURL(config:TencentConfig,options:{timestamp?:number;nonce?:number;voiceId?:string}={}):string {
 if(!/^\d+$/.test(config.appId)||!config.secretId||!config.secretKey)throw new Error('腾讯云实时转写尚未配置完整');
 if(!['16k_zh_en_speaker_2.0','16k_zh_en_2.0'].includes(config.engine))throw new Error('腾讯云 V2 引擎配置不支持当前 16kHz PCM 音频');
 const now=options.timestamp??Math.floor(Date.now()/1000);
 const params:Record<string,string|number>={engine_model_type:config.engine,expired:now+3600,needvad:1,nonce:options.nonce??randomInt(1,2147483647),secretid:config.secretId,timestamp:now,voice_format:1,voice_id:options.voiceId??randomUUID()};
 const raw=Object.keys(params).sort().map(k=>`${k}=${params[k]}`).join('&');
 const path=`asr.cloud.tencent.com/asr/v2/${config.appId}`;
 const signature=createHmac('sha1',config.secretKey).update(`${path}?${raw}`).digest('base64');
 const query=Object.keys(params).sort().map(k=>`${k}=${encodeURIComponent(params[k])}`).join('&');
 return `wss://${path}?${query}&signature=${encodeURIComponent(signature)}`;
}
export function mapTencentMessage(message:unknown,voiceId:string,now=Date.now()):{segments:Segment[];done:boolean} {
 const m=message as Record<string,any>;
 if(!m||!Number.isInteger(m.code))throw new Error('腾讯云转写响应格式错误');
 if(m.code!==0)throw new Error(`腾讯云转写失败（代码 ${m.code}），请检查服务、额度和音频连接`);
 if(m.voice_id&&m.voice_id!==voiceId)throw new Error('腾讯云转写响应会话不匹配');
 const entries=m.sentences==null?[]:Array.isArray(m.sentences)?m.sentences:[m.sentences];
 if(entries.length>100)throw new Error('腾讯云转写响应格式错误');
 const segments:Segment[]=entries.map((s:any):Segment=>{
  const text=s?.sentence??s?.text;
  if(!s||typeof text!=='string'||text.length>20000||!Number.isInteger(s.sentence_id)||s.sentence_id<0||![0,1].includes(s.sentence_type)||!Number.isFinite(s.start_time)||s.start_time<0||!Number.isFinite(s.end_time)||s.end_time<s.start_time)throw new Error('腾讯云转写响应格式错误');
  return {id:`asr:${voiceId}:${s.sentence_id}`,text,speaker:Number.isInteger(s.speaker_id)&&s.speaker_id>=0&&s.speaker_id<=9?`说话人 ${s.speaker_id+1}`:'说话人待确认',startMs:s.start_time,endMs:s.end_time,final:s.sentence_type===1,receivedAt:now,source:'asr'};
 }).filter((s:Segment)=>s.text.trim());
 return {segments,done:m.final===1};
}
export function createTencentASR(callbacks:ASRCallbacks,config=tencentConfig(),options:{socketFactory?:(url:string)=>WebSocket;handshakeMs?:number;finishMs?:number}={}):ASRSession {
 const voiceId=randomUUID();
 const url=signTencentURL(config,{voiceId});
 const ws=options.socketFactory?options.socketFactory(url):new WebSocket(url,{handshakeTimeout:10000,maxPayload:1024*1024});
 let pending=Buffer.alloc(0),ready=false,ending=false,endSent=false,closed=false,lastSent=0,lastInput=Date.now();
 let failure:Error|undefined,finishPromise:Promise<void>|undefined,resolveFinish:(()=>void)|undefined,rejectFinish:((e:Error)=>void)|undefined;
 let finalTimer:ReturnType<typeof setTimeout>|undefined;
 const seen=new Map<string,string>();
 const clear=()=>{clearInterval(pumpTimer);clearTimeout(handshakeTimer);if(finalTimer)clearTimeout(finalTimer);pending=Buffer.alloc(0);seen.clear();};
 const fail=(e:Error)=>{if(closed)return;failure=e;closed=true;clear();ws.terminate();rejectFinish?.(e);callbacks.onError(e);};
 const pump=()=>{
  if(closed||!ready||ws.readyState!==WebSocket.OPEN)return;
  if(ws.bufferedAmount>128000)return fail(new Error('转写连接拥塞，音频已停止发送，请重新开始并记录遗漏'));
  if(!ending&&Date.now()-lastInput>5500)return fail(new Error('音频输入中断超过 5 秒，请重新开始转写并记录遗漏'));
  if(Date.now()-lastSent<200)return;
  if(pending.length>=6400||(ending&&pending.length)){
   const size=Math.min(6400,pending.length),frame=pending.subarray(0,size);pending=Buffer.from(pending.subarray(size));lastSent=Date.now();
   ws.send(frame,{binary:true},err=>{if(err)fail(new Error('腾讯云音频发送失败'));});
  }
  if(ending&&!pending.length&&!endSent){endSent=true;ws.send(JSON.stringify({type:'end'}),err=>{if(err)fail(new Error('腾讯云转写结束请求失败'));});}
 };
 const pumpTimer=setInterval(pump,20);
 const handshakeTimer=setTimeout(()=>fail(new Error('腾讯云转写握手超时')),options.handshakeMs??10000);
 ws.on('message',(data,isBinary)=>{
  if(closed)return;
  try{
   const length=Array.isArray(data)?data.reduce((n,b)=>n+b.byteLength,0):data.byteLength;
   if(isBinary||length>1024*1024)throw new Error('腾讯云转写响应格式错误');
   const m=mapTencentMessage(JSON.parse(data.toString()),voiceId);
   if(!ready){ready=true;clearTimeout(handshakeTimer);callbacks.onStatus('实时转写已连接');}
   for(const s of m.segments){const signature=JSON.stringify([s.text,s.speaker,s.final,s.startMs,s.endMs]);if(seen.get(s.id)!==signature){seen.set(s.id,signature);callbacks.onSegment(s);}if(seen.size>2000)seen.delete(seen.keys().next().value!);}
   if(m.done){closed=true;clear();resolveFinish?.();ws.close(1000);callbacks.onStatus('实时转写已完成');}else pump();
  }catch(error){fail(error instanceof SyntaxError?new Error('腾讯云转写响应不是有效 JSON'):error as Error);}
 });
 ws.on('error',()=>fail(new Error('腾讯云转写连接失败，请检查网络与服务配置')));
 ws.on('close',()=>{if(!closed)fail(new Error('腾讯云转写连接提前关闭，末尾音频可能缺失'));});
 return {
  write(pcm){if(closed||ending)throw failure??new Error('实时转写已关闭');if(!Buffer.isBuffer(pcm)||!pcm.length||pcm.length%2||pcm.length>32000)throw new Error('音频必须是 16kHz 单声道 PCM16，单次最多 1 秒');if(pending.length+pcm.length>160000){fail(new Error('待发送音频超过 5 秒，已停止以避免持续积压，请重新开始'));return;}pending=Buffer.concat([pending,pcm]);lastInput=Date.now();pump();},
  finish(){if(finishPromise)return finishPromise;if(closed)return failure?Promise.reject(failure):Promise.resolve();ending=true;finishPromise=new Promise<void>((resolve,reject)=>{resolveFinish=resolve;rejectFinish=reject;});finalTimer=setTimeout(()=>fail(new Error('等待转写末尾结果超时，末尾音频可能缺失')),options.finishMs??15000);pump();return finishPromise;},
  close(){if(closed)return;closed=true;failure=new Error('实时转写已取消');clear();rejectFinish?.(failure);ws.terminate();}
 };
}
