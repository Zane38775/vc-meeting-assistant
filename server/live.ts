import {appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type WebSocket from 'ws';
import {Store,id,failure,hash} from './store';
import type {Evidence,Material,Meeting,Segment,Question,ResearchBrief,ResearchFinding,LiveCommand,User,LiveEvent} from '../shared/types';
import {validatedMaterialTerms} from '../shared/material-references';
import {currentPreparation} from './project-preparation';
import type {ProviderAPI,ASRSession,AnalysisInput,QuestionDraft} from './providers/contracts';
type Peer={socket:WebSocket;user:User;mid:string};
type ResearchAttempt={questionIds:Set<string>;active:boolean;retryAt:number};
type Runtime={asr?:ASRSession;timer?:ReturnType<typeof setTimeout>;demoTimer?:ReturnType<typeof setInterval>;busy:boolean;pendingSegments:Map<string,number>;flushAnalysis?:boolean;calls:number;lastAnalysis?:number;controllers:Set<AbortController>;demoIndex:number;recordingPeer?:WebSocket;lastAudioSeq:number;audioRejected?:boolean;researchAttempts:Map<string,ResearchAttempt>;generation:number;transition?:Promise<void>};
const MIN_ANALYSIS_INTERVAL_MS=30_000;
const RESEARCH_RETRY_INTERVAL_MS=30_000;
const MIN_FRESH_TEXT=80;
const normalized=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const hasEnoughFreshText=(r:Runtime)=>[...r.pendingSegments.values()].reduce((sum,length)=>sum+length,0)>=MIN_FRESH_TEXT;
function coachingProjectDigest({materials,preparation}:Pick<AnalysisInput,'materials'|'preparation'>):string {
 return hash(JSON.stringify([materials.map(({id,name,pages,summary})=>[id,name,pages,summary]),preparation]));
}

function repeatedQuestion(existing:Question,draft:QuestionDraft):boolean {
 if(normalized(existing.text)===normalized(draft.text))return true;
 if(existing.focus&&draft.focus&&existing.focus!==draft.focus)return false;
 const quote=normalized(draft.quote),priorQuote=normalized(existing.quote);
 if(quote&&quote===priorQuote)return true;
 const nestedQuote=quote&&priorQuote&&(quote.includes(priorQuote)||priorQuote.includes(quote));
 if(!existing.focus||!draft.focus||!nestedQuote)return false;
 if(existing.materialId||draft.materialId){
  return existing.materialId===draft.materialId&&existing.materialPage===draft.materialPage;
 }
 return draft.segmentIds.some(segmentId=>existing.segmentIds.includes(segmentId));
}
const demoLines=[
 ['创业者','我们在做面向工厂设备的边缘 AI 故障检测，目前模型准确率达到了 95%。'],
 ['投资人','这个准确率是在什么样的数据集上测出来的？'],
 ['创业者','目前是三家试点客户的历史数据，测试集大约两万条，还没有完成跨工厂验证。'],
 ['投资人','如果更换设备型号，模型需要重新训练吗？'],
 ['创业者','会做少量微调，部署在边缘设备上，目标是把延迟控制在 100 毫秒以内。'],
 ['创业者','接下来希望补充真实环境的测试数据，验证误报率和设备迁移成本。']
];
export class LiveHub {
 peers=new Set<Peer>(); runtimes=new Map<string,Runtime>(); private closed=false;
 constructor(public store:Store,public providers:ProviderAPI,public dataDir:string){
  store.recoverInterruptedMeetings();
 }
 runtime(mid:string){if(this.closed)failure('服务已经关闭',503);let r=this.runtimes.get(mid);if(!r){r={busy:false,pendingSegments:new Map(),calls:0,controllers:new Set(),demoIndex:0,lastAudioSeq:-1,researchAttempts:new Map(),generation:0};this.runtimes.set(mid,r)}return r;}
 alive(mid:string,r?:Runtime){if(this.closed||(r&&this.runtimes.get(mid)!==r))return false;const m=this.store.get<Meeting>('meeting',mid);return Boolean(m&&this.store.get('project',m.projectId));}
 send(socket:WebSocket,event:LiveEvent){if(socket.readyState===1){if(socket.bufferedAmount>2*1024*1024){socket.close(4008,'读取过慢，请重新连接');return}socket.send(JSON.stringify(event));}}
 status(mid:string,stage:string,message:string,latencyMs?:number){if(!this.alive(mid))return;for(const p of this.peers)if(p.mid===mid)this.send(p.socket,{type:'status',stage,message,latencyMs});}
 broadcast(mid:string){if(!this.alive(mid))return;const seq=this.store.next(mid);for(const p of this.peers)if(p.mid===mid){try{this.send(p.socket,{type:'snapshot',data:this.store.snapshot(mid,p.user.id),seq})}catch{p.socket.close(4003,'访问已撤销')}}}
 attach(socket:WebSocket,user:User,mid:string){const p={socket,user,mid};this.store.meeting(mid,user.id);this.peers.add(p);this.send(socket,{type:'snapshot',data:this.store.snapshot(mid,user.id),seq:this.store.seq(mid)});socket.on('message',data=>{void this.receive(p,data.toString());});socket.on('close',()=>{this.peers.delete(p);const r=this.runtimes.get(mid);if(r?.recordingPeer===socket&&this.alive(mid,r)){if(r.transition)return;this.pause(mid);this.gap(mid,'收音连接断开，已暂停。重连后请继续录音；断开期间声音未转写。');}});}
 revoke(pid:string,uid?:string){for(const p of this.peers){const m=this.store.get<Meeting>('meeting',p.mid);if(m?.projectId===pid&&(!uid||p.user.id===uid))p.socket.close(4003,'访问已撤销');}}
 private async receive(p:Peer,raw:string){
  let cmd:LiveCommand|undefined;
  try{
   if(raw.length>100000)failure('消息过大');
   try{cmd=JSON.parse(raw)}catch{failure('无效消息')}
   if(!cmd||typeof cmd!=='object')failure('无效消息');
   await this.command(p,cmd);
  }catch(error){
   const command=typeof cmd?.type==='string'&&cmd.type.length<=32?cmd.type:undefined;
   this.send(p.socket,{type:'error',message:error instanceof Error?error.message:'操作失败',command});
  }
 }
 async command(p:Peer,cmd:LiveCommand){if(this.closed)failure('服务已经关闭',503);const m=this.store.meeting(p.mid,p.user.id);if(cmd.type==='ping'){this.send(p.socket,{type:'pong'});return}if(m.ownerId!==p.user.id)failure('仅会议主持人可以控制录音',403);const r=this.runtime(m.id);
  if(['start','resume','demo.start','pause','stop'].includes(cmd.type)){
    if(r.transition)failure('正在完成上一段语音，请稍后再试',409);
    if(r.recordingPeer&&r.recordingPeer!==p.socket)failure('另一窗口正在收音，请从该窗口控制录音',409);
  }
  if(cmd.type==='start'||cmd.type==='resume'||cmd.type==='demo.start'){if(m.status==='ended')failure('会议已经结束');if(r.recordingPeer&&r.recordingPeer!==p.socket)failure('另一窗口正在收音');if(cmd.type==='demo.start'&&!m.demo)failure('真实会议不能切换成演示');if(!m.demo&&!this.providers.getCapabilities().asr)failure('本地语音模型尚未就绪，请检查模型文件与系统支持情况');if(m.status==='live'&&r.recordingPeer===p.socket)return;r.recordingPeer=p.socket;r.lastAudioSeq=-1;r.audioRejected=false;m.status='live';m.startedAt??=Date.now();this.store.put('meeting',m.id,m.projectId,m);if(m.demo)this.startDemo(m);else this.openASR(m);this.broadcast(m.id);return;}
  if(cmd.type==='pause'){if(m.status==='ended')return;await this.finish(m.id,'paused');return;}
  if(cmd.type==='stop'){if(m.status==='ended')return;await this.finish(m.id,'ended');return;}
  if(cmd.type==='audio'){
   if(m.demo||m.status!=='live'||r.recordingPeer!==p.socket)failure('当前没有开启真实收音');
   try{
    if(!Number.isSafeInteger(cmd.seq)||cmd.seq<0||typeof cmd.pcm!=='string'||cmd.pcm.length>30000)failure('无效音频帧');
    if(cmd.seq<=r.lastAudioSeq){this.send(p.socket,{type:'audio.ack',seq:cmd.seq});return;}
    const bytes=Buffer.from(cmd.pcm,'base64');
    if(bytes.length>16000||bytes.length%2)failure('音频帧格式错误');
    if(!r.asr)failure('语音连接不可用，请暂停后重试');
    r.asr.write(bytes);
    r.lastAudioSeq=cmd.seq;
    if(m.retainAudio){mkdirSync(join(this.dataDir,'audio'),{recursive:true});appendFileSync(join(this.dataDir,'audio',`${m.id}.pcm`),bytes);}
    this.send(p.socket,{type:'audio.ack',seq:cmd.seq});
   }catch(error){
    if(!r.audioRejected&&r.recordingPeer===p.socket){
     r.audioRejected=true;
     this.gap(m.id,'服务未能接收部分音频，请核对当时的转写。');
    }
    throw error;
   }
   return;
  }
  if(cmd.type==='transcript.manual'){if(m.status==='ended')failure('会议已结束');if(typeof cmd.text!=='string'||!cmd.text.trim()||cmd.text.length>6000)failure('请输入有效文字');const at=Math.max(0,Date.now()-(m.startedAt||Date.now()));this.final(m.id,{id:id(),text:cmd.text.trim(),speaker:String(cmd.speaker||'手动补充').slice(0,60),startMs:at,endMs:at,receivedAt:Date.now(),final:true,source:'manual'});return;}
  if(cmd.type==='gap'){this.gap(m.id,String(cmd.message||'转写中断').slice(0,300));return;}failure('不支持的消息类型');
 }
 openASR(m:Meeting){
  const r=this.runtime(m.id),generation=++r.generation;
  const previous=r.asr;r.asr=undefined;previous?.close();
  const current=()=>this.alive(m.id,r)&&r.generation===generation;
  const offset=Math.max(0,Date.now()-(m.startedAt||Date.now()));
  try{
    const hotwords=this.store.list<Material>('material',m.projectId)
      .flatMap(material=>validatedMaterialTerms(material.pages,material.terms).map(({term})=>term));
    const session=this.providers.createASR({
      onSegment:s=>{if(!current())return;const segment={...s,startMs:s.startMs+offset,endMs:s.endMs+offset};if(segment.final)this.final(m.id,segment);else for(const p of this.peers)if(p.mid===m.id)this.send(p.socket,{type:'transcript.partial',data:segment});},
      onStatus:message=>{if(current())this.status(m.id,'asr',message);},
      onError:error=>{if(!current())return;this.status(m.id,'asr',error.message);if(r.transition)return;this.pause(m.id);this.gap(m.id,'语音识别中断，未确认的语音可能缺失。请检查连接后继续。');},
    },{hotwords});
    if(current())r.asr=session;else session.close();
  }catch(e){if(current())this.pause(m.id);throw e;}
 }
 async finish(mid:string,target:'paused'|'ended'){
  const r=this.runtime(mid);if(r.transition)failure('正在完成上一段语音，请稍后再试',409);
  const m=this.store.get<Meeting>('meeting',mid);if(!m||!this.alive(mid,r))return;
  const session=r.asr,generation=r.generation;
  m.status='paused';if(session)m.finishingCapture=true;
  this.store.put('meeting',mid,m.projectId,m);
  clearInterval(r.demoTimer);r.demoTimer=undefined;
  this.broadcast(mid);this.status(mid,'asr','正在处理最后一段语音');
  const current=()=>this.alive(mid,r)&&r.generation===generation;
  const task=Promise.resolve().then(async()=>{
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      if(session)await Promise.race([session.finish(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('语音尾段处理超时')),7000);})]);
    }catch{if(current())this.gap(mid,'最后一段语音未能确认，请核对会议结尾。');}
    finally{
      clearTimeout(timeout);
      if(current()){
        ++r.generation;r.asr=undefined;r.recordingPeer=undefined;
        session?.close();
        const latest=this.store.get<Meeting>('meeting',mid)!;
        latest.status=target;delete latest.finishingCapture;
        if(target==='ended')latest.endedAt=Date.now();
        this.store.put('meeting',mid,latest.projectId,latest);
        this.broadcast(mid);this.status(mid,'asr',target==='ended'?'录音已结束':'已暂停收音');
      }else session?.close();
    }
  });
  r.transition=task;
  try{await task;}finally{
    if(this.alive(mid,r)&&r.transition===task){
      r.transition=undefined;
      this.schedule(mid,r,true);
    }
  }
 }
 // Abrupt termination is reserved for device/network/provider failures.
 pause(mid:string){if(!this.alive(mid))return;const m=this.store.get<Meeting>('meeting',mid);const r=this.runtimes.get(mid);if(!m||!r||m.status==='ended')return;++r.generation;clearInterval(r.demoTimer);r.demoTimer=undefined;const session=r.asr;r.asr=undefined;r.recordingPeer=undefined;session?.close();m.status='paused';this.store.put('meeting',mid,m.projectId,m);this.broadcast(mid);this.status(mid,'asr','已暂停收音');}
 gap(mid:string,text:string){if(!this.alive(mid))return;const m=this.store.get<Meeting>('meeting',mid)!;const at=Math.max(0,Date.now()-(m.startedAt||Date.now()));this.store.finalSegment(mid,{id:id(),text,speaker:'系统',startMs:at,endMs:at,receivedAt:Date.now(),final:true,source:'manual',gap:true});this.broadcast(mid);}
 final(mid:string,segment:Segment){
  if(!this.alive(mid)||!this.store.finalSegment(mid,segment))return;
  this.broadcast(mid);
  const m=this.store.get<Meeting>('meeting',mid);
  if(segment.gap||m?.demo)return;
  if(!this.providers.getCapabilities().deepseek){this.status(mid,'coach','DeepSeek 尚未配置，字幕正常运行');return;}
  const r=this.runtime(mid);
  const freshText=normalized(segment.text).length;
  if(freshText)r.pendingSegments.set(segment.id,freshText);
  else r.pendingSegments.delete(segment.id);
  this.schedule(mid,r);
 }
 startDemo(m:Meeting){const r=this.runtime(m.id);if(r.demoTimer)clearInterval(r.demoTimer);let part=0;const tick=()=>{if(!this.alive(m.id,r)){clearInterval(r.demoTimer);return;}const idx=r.demoIndex% demoLines.length;const [speaker,text]=demoLines[idx];part++;const startMs=r.demoIndex*4500;const receivedAt=Date.now();const segment:Segment={id:`demo-${r.demoIndex}`,speaker,text:text.slice(0,Math.min(text.length,part*9)),startMs,endMs:startMs+4000,receivedAt,final:part*9>=text.length,source:'demo',latencyMs:0};if(segment.final){this.store.finalSegment(m.id,segment);if(idx===0||idx===4){const q:Question={id:`demo-q-${idx}`,text:idx===0?'95% 的测试集如何划分？是否有跨客户的独立验证？':'100 毫秒包含采集、预处理和网络耗时吗？',reason:idx===0?'区分历史测试指标与真实环境表现。':'确认性能指标的测量边界与硬件条件。',quote:text,segmentIds:[segment.id],status:'new',evidenceIds:[],createdAt:Date.now(),kind:'inference',latencyMs:0};if(!this.store.get('question',`${m.id}:${q.id}`))this.store.put('question',`${m.id}:${q.id}`,m.id,q);}r.demoIndex++;part=0;this.broadcast(m.id);this.status(m.id,'coach','演示追问 · 预设内容，不是模型实测');if(r.demoIndex>=demoLines.length){clearInterval(r.demoTimer);r.demoTimer=undefined;this.status(m.id,'asr','演示段落播放完毕，可继续手动补充或结束会议');}}else for(const p of this.peers)if(p.mid===m.id)this.send(p.socket,{type:'transcript.partial',data:segment});};r.demoTimer=setInterval(tick,500);tick();this.status(m.id,'asr','演示播放中 · 未使用麦克风或真实 API');}
 private projectAnalysisContext(projectId:string):Pick<AnalysisInput,'materials'|'preparation'> {
  const materials=this.store.list<Material>('material',projectId);
  const {preparation}=currentPreparation(this.store,projectId,materials);
  return {materials,...(preparation?{preparation}:{})};
 }
 input(mid:string):AnalysisInput {
  const m=this.store.get<Meeting>('meeting',mid)!;
  return {projectName:this.store.get<any>('project',m.projectId)?.name||'',segments:this.store.list<Segment>('segment',mid).filter(s=>!s.gap),questions:this.store.list<Question>('question',mid),researchBriefs:this.store.list<ResearchBrief>('researchBrief',mid),evidence:this.store.list<Evidence>('evidence',mid),...this.projectAnalysisContext(m.projectId)};
 }
 private schedule(mid:string,r:Runtime,flush=false){
  if(!r.pendingSegments.size){r.flushAnalysis=false;return;}
  if(flush){
   r.flushAnalysis=true;
   clearTimeout(r.timer);
   r.timer=undefined;
  }
  if(r.busy||r.timer||r.transition)return;
  if(!r.flushAnalysis&&!hasEnoughFreshText(r))return;
  const configured=Number(process.env.AI_MIN_INTERVAL_MS);
  const interval=Number.isFinite(configured)?Math.max(MIN_ANALYSIS_INTERVAL_MS,configured):MIN_ANALYSIS_INTERVAL_MS;
  const delay=r.flushAnalysis||r.lastAnalysis===undefined?0:Math.max(0,interval-(Date.now()-r.lastAnalysis));
  r.timer=setTimeout(()=>{
   r.timer=undefined;
   void this.analyze(mid,r);
  },delay);
 }
 private async analyze(mid:string,r:Runtime){
  if(!this.alive(mid,r)||r.busy||r.transition||!r.pendingSegments.size)return;
  if(!r.flushAnalysis&&!hasEnoughFreshText(r))return;
  const newSegmentIds=[...r.pendingSegments.keys()];
  r.pendingSegments.clear();
  r.flushAnalysis=false;
  if(!this.providers.getCapabilities().deepseek)return;
  if(r.calls>=Number(process.env.AI_MAX_CALLS_PER_MEETING||150)){
   this.status(mid,'coach','已达到本场 AI 调用上限，字幕继续运行');
   return;
  }
  const started=Date.now();
  r.busy=true;
  r.calls++;
  r.lastAnalysis=started;
  const controller=new AbortController();
  r.controllers.add(controller);
  const timer=setTimeout(()=>controller.abort(),15000);
  this.status(mid,'coach','正在梳理新增发言');
  try{
   const input=this.input(mid);
   const sourceDigest=coachingProjectDigest(input);
   const {questions:[draft]}=await this.providers.analyzeContext({...input,newSegmentIds},controller.signal);
   if(controller.signal.aborted||!this.alive(mid,r))return;
   const existing=this.store.list<Question>('question',mid);
   if(!draft||existing.some(question=>repeatedQuestion(question,draft))){
    this.status(mid,'coach','已梳理，暂无值得打断的追问',Date.now()-started);
    return;
   }
   const {projectId}=this.store.get<Meeting>('meeting',mid)!;
   if(coachingProjectDigest(this.projectAnalysisContext(projectId))!==sourceDigest){
    this.status(mid,'coach','项目资料或会前研判已更新，将结合后续发言重新分析',Date.now()-started);
    return;
   }
   const q:Question={...draft,id:id(),status:'new',createdAt:Date.now(),kind:'inference',evidenceIds:[],latencyMs:Date.now()-started};
   this.store.put('question',`${mid}:${q.id}`,mid,q);
   this.broadcast(mid);
   this.status(mid,'coach','已找到值得追问的问题',Date.now()-started);
   if(draft.researchQuery)void this.research(mid,q,draft.researchQuery);
  }catch{
   this.status(mid,'coach',controller.signal.aborted?'追问请求超时，字幕继续运行':'追问暂不可用，请检查服务配置');
  }finally{
   clearTimeout(timer);
   r.controllers.delete(controller);
   r.busy=false;
   if(this.alive(mid,r))this.schedule(mid,r);
  }
 }
 private linkResearchEvidence(mid:string,questionIds:Iterable<string>,evidence:Evidence[]){
  const evidenceIds=evidence.map(source=>source.id);
  for(const questionId of questionIds){
   const key=`${mid}:${questionId}`;
   const question=this.store.get<Question>('question',key);
   if(question)this.store.put('question',key,mid,{...question,evidenceIds});
  }
 }
 async research(mid:string,q:Question,query:string){
  if(!this.alive(mid))return;
  const r=this.runtime(mid);
  const priorSources=this.store.list<Evidence>('evidence',mid).filter(source=>source.query===query);
  if(priorSources.length){
   this.linkResearchEvidence(mid,[q.id],priorSources);
   this.broadcast(mid);
   return;
  }
  const maxCalls=Number(process.env.AI_MAX_CALLS_PER_MEETING||150);
  const attempt=r.researchAttempts.get(query)??{questionIds:new Set<string>(),active:false,retryAt:0};
  attempt.questionIds.add(q.id);
  r.researchAttempts.set(query,attempt);
  if(attempt.active||Date.now()<attempt.retryAt||r.calls>=maxCalls)return;
  attempt.active=true;
  r.calls++;
  const controller=new AbortController();
  r.controllers.add(controller);
  let timer=setTimeout(()=>controller.abort(),18000);
  const started=Date.now();
  this.status(mid,'research','正在检索公开技术资料');
  try{
   const evidence=await this.providers.researchTopic(query,controller.signal);
   if(!this.alive(mid,r))return;
   if(controller.signal.aborted){
    this.status(mid,'research','检索未完成，相关内容仍待核实');
    return;
   }
   if(!evidence.length){
    this.status(mid,'research','没有找到可用资料，仍需核实',Date.now()-started);
    return;
   }
   for(const source of evidence)this.store.put('evidence',`${mid}:${source.id}`,mid,source);
   this.linkResearchEvidence(mid,attempt.questionIds,evidence);
   r.researchAttempts.delete(query);
   this.broadcast(mid);
   let findings:ResearchFinding[]=[];
   if(this.providers.summarizeResearch&&r.calls<maxCalls){
    r.calls++;
    clearTimeout(timer);
    timer=setTimeout(()=>controller.abort(),18000);
    this.status(mid,'research','来源已补充，正在整理中文资料');
    try{
     findings=await this.providers.summarizeResearch(query,evidence,controller.signal);
    }catch{/* The evidence remains available if its summary cannot be generated. */}
   }
   if(!this.alive(mid,r))return;
   if(controller.signal.aborted)findings=[];
   const brief:ResearchBrief={query,findings,status:findings.length?'ready':'unavailable',updatedAt:Date.now()};
   this.store.put('researchBrief',`${mid}:${query}`,mid,brief);
   this.broadcast(mid);
   this.status(mid,'research',findings.length?'中文资料整理已更新':'中文资料整理未完成，可核对检索来源',Date.now()-started);
  }catch{
   if(this.alive(mid,r))this.status(mid,'research','检索未完成，相关内容仍待核实');
  }finally{
   clearTimeout(timer);
   r.controllers.delete(controller);
   attempt.active=false;
   attempt.retryAt=Date.now()+RESEARCH_RETRY_INTERVAL_MS;
  }
 }
 dispose(mid:string){const r=this.runtimes.get(mid);if(!r)return;this.runtimes.delete(mid);++r.generation;clearTimeout(r.timer);clearInterval(r.demoTimer);for(const c of r.controllers)c.abort();r.asr?.close();r.asr=undefined;r.recordingPeer=undefined;}
 close(){if(this.closed)return;this.closed=true;for(const mid of this.runtimes.keys())this.dispose(mid);for(const p of this.peers)p.socket.close(1001,'服务关闭');this.peers.clear();}
}
