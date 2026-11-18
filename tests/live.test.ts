import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {Store} from '../server/store';
import {LiveHub} from '../server/live';
import {preparationSourceDigest,type StoredPreparation} from '../server/project-preparation';
import type {AnalysisInput,ASRCallbacks,ProviderAPI} from '../server/providers/contracts';
import type {Material,Meeting,Segment} from '../shared/types';

class Socket extends EventEmitter {
  readyState=1; bufferedAmount=0; messages:any[]=[];
  send(raw:string){this.messages.push(JSON.parse(raw));this.emit('sent',raw);}
  close(code=1006){if(this.readyState===3)return;this.readyState=3;this.emit('close',code);}
}
function fixture(t:any, dbPath=':memory:') {
  const store=new Store(dbPath);
  const user={id:'user',name:'Host',email:'host@example.com'};
  store.put('project','project','project',{id:'project',name:'Test'});
  store.put('member','project:user','project',{role:'admin'});
  const meeting:Meeting={id:'meeting',projectId:'project',title:'test',mode:'offline',demo:false,status:'ready',createdAt:Date.now(),ownerId:'user',retainAudio:false};
  store.put('meeting','meeting','project',meeting);
  const sessions:Array<{callbacks:ASRCallbacks;writes:Buffer[];closed:boolean;finish:()=>Promise<void>;close:()=>void;write:(b:Buffer)=>void;hotwords?:readonly string[]}>=[];
  const providers:ProviderAPI={getCapabilities:()=>({asr:true,deepseek:false,model:'test',version:'test'}),analyzeContext:async()=>({questions:[]}),researchTopic:async()=>[],summarizeMeeting:async()=>'',summarizeMaterial:async()=>'',createASR(callbacks,options){
    const session={callbacks,hotwords:options?.hotwords,writes:[] as Buffer[],closed:false,finish:async()=>{},close(){this.closed=true;},write(b:Buffer){this.writes.push(b);}};
    sessions.push(session); return session;
  }};
  const hub=new LiveHub(store,providers,'.');
  const socket=new Socket();hub.attach(socket as any,user,'meeting');
  const peer={socket:socket as any,user,mid:'meeting'};
  t.after(()=>{hub.close();store.close();});
  return {store,hub,sessions,peer,socket,user,providers,command:(type:'start'|'pause'|'resume'|'stop')=>hub.command(peer,{type})};
}
const segment=(id='sentence'):Segment=>({id,text:'最后一句完整语音',speaker:'speaker_0',startMs:0,endMs:1000,receivedAt:Date.now(),source:'asr',final:true});
const settleMessages = () => new Promise<void>(resolve => setImmediate(resolve));

async function recordingClient(f: ReturnType<typeof fixture>, stop: (onTail: () => void) => Promise<void> = async () => {}, holdResume?: (deliver: () => void) => void, autoStart=true, authorize?: (signal?:AbortSignal)=>Promise<void>) {
  const code = buildSync({
    entryPoints: [fileURLToPath(new URL('../client/useMeeting.ts', import.meta.url))],
    bundle: true, write: false, format: 'cjs', external: ['react', './audio', './api'],
  }).outputFiles[0].text;
  const errors: string[] = [];
  const commands: Record<string,any>[]=[];
  let stops = 0;
  let resumes = 0;
  let dispose = () => {};
  let pushAudio = () => {};
  class BrowserSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    onopen?: () => void;
    onmessage?: (event: {data: string}) => void;
    onclose?: (event: {code: number}) => void;
    constructor() {
      f.socket.on('sent', (data: string) => queueMicrotask(() => this.onmessage?.({data})));
      f.socket.on('close', (code:number) => {this.readyState=3;queueMicrotask(() => this.onclose?.({code}));});
      queueMicrotask(() => this.onopen?.());
    }
    send(raw: string) {
      commands.push(JSON.parse(raw));
      const deliver = () => f.socket.emit('message', Buffer.from(raw));
      if (holdResume && JSON.parse(raw).type === 'resume') holdResume(deliver);
      else queueMicrotask(deliver);
    }
    close(){f.socket.close();}
  }
  const scope = {
    module: {exports: {} as {useMeeting: typeof import('../client/useMeeting').useMeeting}},
    URL, WebSocket: BrowserSocket, window: {location: {href: 'http://localhost/meeting'}},
    AbortController, crypto:globalThis.crypto, setTimeout, clearTimeout, clearInterval, setInterval: () => 1,
    require(name: string) {
      switch (name) {
        case 'react':
          return {
            useRef: (current: unknown) => ({current}),
            useState: (value: unknown) => [value, () => {}],
            useCallback: (fn: unknown) => fn,
            useEffect: (effect: () => () => void) => {dispose=effect();},
          };
        case './api':
          return {api: async () => f.store.snapshot('meeting', 'user')};
        case './audio':
          return {captureAudio: async ({onChunk,signal}: import('../client/audio').CaptureOptions) => {
            if(authorize)await authorize(signal);
            const onAudio = () => onChunk({pcm: 'AQA=', capturedAt: 1, seq: 0});
            pushAudio = onAudio;
            return {async stop() { stops++; await stop(onAudio); },resume(){resumes++;}};
          }};
        default:
          throw new Error(`Unexpected test dependency ${name}`);
      }
    },
  };
  runInNewContext(code, scope);
  const client = scope.module.exports.useMeeting('meeting', error => errors.push(error));
  await settleMessages();
  if(autoStart){
    await client.begin();
    await settleMessages();
    assert.equal(f.store.snapshot('meeting', 'user').meeting.status, 'live');
  }
  return {client, errors, commands, dispose, get stops() { return stops; },get resumes() {return resumes;}, pushAudio: () => pushAudio()};
}

test('a rejected manual supplement leaves the real recording and ASR session active', async t => {
  const f = fixture(t);
  const recorder = await recordingClient(f);
  recorder.client.send({type: 'transcript.manual', text: '  \n  '});
  await settleMessages();
  assert.match(recorder.errors.at(-1) ?? '', /有效文字/);
  assert.equal(f.store.snapshot('meeting', 'user').meeting.status, 'live');
  assert.equal(f.store.snapshot('meeting', 'user').segments.length, 0);
  assert.equal(f.sessions[0].closed, false);
  assert.equal(recorder.stops, 0);
});

test('ASR uses source-verified terms from this project on each new recording session', async t => {
  const f = fixture(t);
  const material={id:'bp',projectId:'project',name:'BP.pdf',pages:[{page:1,text:'We used ace-step at a home party.'}],terms:[
    {term:'ace-step',page:1,quote:'We used ace-step at a home party.'},
    {term:'home party',page:1,quote:'We used ace-step at a home party.'},
    {term:'Other',page:1,quote:'No longer on the page.'},
  ]};
  f.store.put('material',material.id,'project',material);
  f.store.put('material','foreign-bp','foreign-project',{...material,id:'foreign-bp',projectId:'foreign-project',pages:[{page:1,text:'Foreign tool'}],terms:[{term:'Foreign tool',page:1,quote:'Foreign tool'}]});
  await f.command('start');
  assert.deepEqual(f.sessions[0].hotwords,['ace-step','home party']);
  await f.command('pause');
  f.store.put('material',material.id,'project',{...material,pages:[]});
  await f.command('resume');
  assert.deepEqual(f.sessions[1].hotwords,[]);
});

test('a project update during resume keeps the recorder alive until live capture is confirmed', async t => {
  const f = fixture(t);
  let deliverResume: (() => void) | undefined;
  const recorder = await recordingClient(f, undefined, deliver => { deliverResume = deliver; });
  await recorder.client.control('pause');
  await settleMessages();
  assert.equal(recorder.stops, 1);
  assert.equal(f.store.snapshot('meeting', 'user').meeting.status, 'paused');
  const starting=recorder.client.begin();
  f.hub.broadcast('meeting');
  await settleMessages();
  assert.ok(deliverResume);
  deliverResume();
  await starting;
  await settleMessages();
  recorder.pushAudio();
  await settleMessages();
  assert.equal(f.store.snapshot('meeting', 'user').meeting.status, 'live');
  assert.deepEqual(f.sessions[1].writes, [Buffer.from([1, 0])]);
  assert.equal(recorder.stops, 1);
  await f.command('pause');
  await settleMessages();
  assert.equal(recorder.stops, 2);
});

test('capture waits past five seconds for matching ready and never submits pre-ready PCM',async t=>{
  const f=fixture(t);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:60_000});
  const create=f.providers.createASR;
  let ready!:()=>void;
  f.providers.createASR=(...args)=>Object.assign(create(...args),{ready:new Promise<void>(resolve=>{ready=resolve;})});
  const recorder=await recordingClient(f,undefined,undefined,false);
  const starting=recorder.client.begin();
  await settleMessages();
  const request=recorder.commands.find(command=>command.type==='start');
  assert.equal(typeof request?.requestId,'string');
  await assert.rejects(f.hub.command({...f.peer,socket:new Socket() as any},{type:'start'}),/另一窗口/);
  await assert.rejects(f.hub.command(f.peer,{type:'audio',pcm:'AQA=',seq:0,capturedAt:1}),/就绪/);
  f.socket.send(JSON.stringify({type:'capture.ready',meetingId:'meeting',requestId:'previous'}));
  f.socket.send(JSON.stringify({type:'capture.ready',meetingId:'another-meeting',requestId:request?.requestId}));
  await settleMessages();
  for(let frame=0;frame<26;frame++){t.mock.timers.tick(200);recorder.pushAudio();}
  await settleMessages();
  assert.equal(recorder.resumes,0);
  assert.equal(recorder.commands.filter(command=>command.type==='audio').length,0);
  assert.equal(f.store.snapshot('meeting','user').meeting.status,'ready');
  assert.equal(f.sessions[0].writes.length,0);
  ready();
  await starting;
  recorder.pushAudio();
  await settleMessages();
  assert.equal(recorder.resumes,1);
  assert.equal(f.store.snapshot('meeting','user').meeting.status,'live');
  assert.deepEqual(f.sessions[0].writes,[Buffer.from([1,0])]);
});

for(const reason of ['cancel','end','disconnect','switch','revoke','delete','timeout'] as const)
test(`pending capture releases resources and ignores late ready on ${reason}`,async t=>{
  const f=fixture(t);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:60_000});
  const create=f.providers.createASR;
  let ready!:()=>void;
  f.providers.createASR=(...args)=>Object.assign(create(...args),{ready:new Promise<void>(resolve=>{ready=resolve;})});
  const recorder=await recordingClient(f,undefined,undefined,false);
  const starting=reason==='timeout'?assert.rejects(recorder.client.begin(),/语音模型加载超时/):recorder.client.begin();
  await settleMessages();
  assert.equal(f.sessions.length,1);
  if(reason==='cancel'||reason==='end')await recorder.client.control(reason==='cancel'?'pause':'stop');
  else if(reason==='disconnect')f.socket.close();
  else if(reason==='switch')recorder.dispose();
  else if(reason==='revoke'){
    f.store.delete('member','project:user');
    f.hub.revoke('project','user');
  }else if(reason==='delete'){
    f.hub.revoke('project');
    f.hub.dispose('meeting');
    f.store.deleteScope('meeting');
    f.store.deleteScope('project');
  }else t.mock.timers.tick(24_000);
  await starting;
  assert.equal(f.sessions[0].closed,true);
  ready();
  await settleMessages();
  assert.equal(recorder.resumes,0);
  assert.equal(recorder.stops,1);
  assert.ok(!f.socket.messages.some(message=>message.type==='capture.ready'));
  assert.equal(f.store.get<Meeting>('meeting','meeting')?.status,reason==='delete'?undefined:reason==='end'?'ended':'ready');
  assert.equal(f.store.list('segment','meeting').length,0);
  if(reason==='cancel'){
    f.providers.createASR=create;
    await recorder.client.begin();
    assert.equal(f.store.get<Meeting>('meeting','meeting')?.status,'live');
  }
});

test('permission denial and cancellation leave the meeting waiting to start',async t=>{
  const f=fixture(t);
  let requests=0;
  const recorder=await recordingClient(f,undefined,undefined,false,signal=>{
    if(++requests===1)return Promise.reject(new Error('麦克风授权未获准'));
    if(requests===2)return new Promise<void>((_,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    return Promise.resolve();
  });
  await assert.rejects(recorder.client.begin(),/麦克风授权未获准/);
  const starting=recorder.client.begin();
  await recorder.client.control('pause');
  await starting;
  assert.deepEqual(recorder.commands,[]);
  assert.equal(f.sessions.length,0);
  assert.equal(f.store.get<Meeting>('meeting','meeting')?.status,'ready');
  await recorder.client.begin();
  assert.equal(f.store.get<Meeting>('meeting','meeting')?.status,'live');
});

test('failed startup closes capture and allows retry without reporting lost audio',async t=>{
  const f=fixture(t);
  const create=f.providers.createASR;
  let rejectReady!:(error:Error)=>void;
  f.providers.createASR=(...args)=>Object.assign(create(...args),{ready:new Promise<void>((_,reject)=>{rejectReady=reject;})});
  const recorder=await recordingClient(f,undefined,undefined,false);
  const first=assert.rejects(recorder.client.begin(),/模型加载失败/);
  await settleMessages();
  await assert.rejects(recorder.client.begin(),/仍在进行/);
  rejectReady(new Error('模型加载失败'));
  await first;
  assert.equal(f.sessions[0].closed,true);
  assert.equal(recorder.stops,1);
  assert.equal(f.store.snapshot('meeting','user').meeting.status,'ready');
  assert.equal(f.store.snapshot('meeting','user').segments.length,0);
  f.providers.createASR=create;
  await recorder.client.begin();
  assert.equal(recorder.resumes,1);
  assert.equal(f.store.snapshot('meeting','user').meeting.status,'live');
});

test('a rejected audio frame stops recording and leaves a gap', async t => {
  const f = fixture(t);
  const recorder = await recordingClient(f);
  recorder.client.send({type: 'audio', seq: 1, capturedAt: 1, pcm: 'AQ=='});
  await settleMessages();
  const snapshot = f.store.snapshot('meeting', 'user');
  assert.equal(recorder.stops, 1);
  assert.equal(snapshot.meeting.status, 'paused');
  assert.equal(snapshot.segments.filter(segment => segment.gap).length, 1);
});

test('ending still persists a gap if the recorder cannot confirm the tail', async t => {
  const f = fixture(t);
  const {client} = await recordingClient(f, async () => { throw new Error('等待最后一段音频超时'); });
  await client.control('stop');
  await settleMessages();
  const snapshot = f.store.snapshot('meeting', 'user');
  assert.equal(snapshot.meeting.status, 'ended');
  assert.equal(snapshot.segments.filter(s => s.gap).length, 1);
  assert.match(snapshot.segments[0].text, /最后一段音频超时/);
});

test('ending records a single gap when the service rejects the last audio frame', async t => {
  const f = fixture(t);
  const {client, errors} = await recordingClient(f, async onTail => onTail());
  f.sessions[0].write = () => { throw new Error('拒绝尾帧'); };
  await client.control('stop');
  await settleMessages();
  assert.match(errors.at(-1) ?? '', /拒绝尾帧/);
  const snapshot = f.store.snapshot('meeting', 'user');
  assert.equal(snapshot.meeting.status, 'ended');
  assert.equal(snapshot.segments.filter(segment => segment.gap).length, 1);
});

test('an overlapping end request leaves the paused capture tail intact and can be retried', async t => {
  const f = fixture(t);
  let confirm: () => void = () => {};
  const {client} = await recordingClient(f, onTail => new Promise<void>(resolve => {
    confirm = () => { onTail(); resolve(); };
  }));
  const pausing = client.control('pause');
  const ending = client.control('stop').then(() => '', error => String(error));
  await settleMessages();
  confirm();
  await pausing;
  assert.match(await ending, /正在完成最后一段音频/);
  await settleMessages();
  assert.deepEqual(f.sessions[0].writes, [Buffer.from([1, 0])]);
  assert.equal(f.store.snapshot('meeting', 'user').meeting.status, 'paused');
  await client.control('stop');
  await settleMessages();
  assert.equal(f.store.snapshot('meeting', 'user').meeting.status, 'ended');
});

test('pause finishes provider tail before closing; duplicate final does not schedule coaching twice',async t=>{
  const f=fixture(t);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:60_000});
  f.providers.getCapabilities=()=>({asr:true,deepseek:true,model:'test',version:'test'});
  const analyzed:(string[]|undefined)[]=[];
  f.providers.analyzeContext=async input=>{analyzed.push(input.newSegmentIds);return {questions:[]};};
  await f.command('start');
  f.sessions[0].finish=async()=>{f.sessions[0].callbacks.onSegment(segment());f.sessions[0].callbacks.onSegment(segment());};
  await f.command('pause');
  t.mock.timers.tick(0);
  await settleMessages();
  assert.equal(f.store.snapshot('meeting','user').segments.length,1);
  assert.deepEqual(analyzed,[['sentence']]);
  assert.equal(f.sessions[0].closed,true);
  assert.equal(f.store.get<Meeting>('meeting','meeting')?.status,'paused');
});

test('resume cannot replace an ASR session while stop is awaiting its final response',async t=>{
  const f=fixture(t);await f.command('start');
  let finish!:()=>void; f.sessions[0].finish=()=>new Promise(resolve=>{finish=resolve;});
  const stopping=f.command('stop'); await Promise.resolve();
  await assert.rejects(f.command('resume'), /正在|完成|结束/);
  assert.equal(f.sessions.length,1);
  finish();await stopping;
  assert.equal(f.store.get<Meeting>('meeting','meeting')?.status,'ended');
});

test('old provider callbacks cannot append text or pause a newly resumed recording',async t=>{
  const f=fixture(t);await f.command('start');await f.command('pause');await f.command('resume');
  f.sessions[0].callbacks.onSegment(segment('obsolete'));
  f.sessions[0].callbacks.onError(new Error('stale close'));
  assert.equal(f.store.get<Meeting>('meeting','meeting')?.status,'live');
  assert.equal(f.store.snapshot('meeting','user').segments.length,0);
  assert.equal(f.sessions[1].closed,false);
});

test('another tab of the same host cannot pause the active recording peer',async t=>{
  const f=fixture(t);await f.command('start');
  const other=new Socket(); const peer={...f.peer,socket:other as any};
  await assert.rejects(f.hub.command(peer,{type:'pause'}), /窗口|收音|连接/);
  assert.equal(f.sessions[0].closed,false);
});

test('late callbacks after project deletion or server close do not recreate data',async t=>{
  const f=fixture(t);await f.command('start');
  f.store.deleteScope('meeting');f.store.deleteScope('project');
  f.sessions[0].callbacks.onSegment(segment());
  assert.equal(f.store.list('segment','meeting').length,0);
  f.hub.close();
  assert.doesNotThrow(()=>f.sessions[0].callbacks.onError(new Error('late')));
  f.sessions[0].callbacks.onSegment(segment('after-close'));
  assert.equal(f.store.list('segment','meeting').length,0);
});

test('shutdown invalidates provider callbacks even when meeting records still exist',async t=>{
  const f=fixture(t);await f.command('start');f.hub.close();
  f.sessions[0].callbacks.onSegment(segment('after-close'));
  assert.equal(f.store.list('segment','meeting').length,0);
});

test('reopening the service pauses interrupted recordings and saves exactly one gap', t => {
  const f = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'vc-interrupted-recording-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const dbPath = join(dir, 'vc.sqlite');
  const written = new Store(dbPath);
  try {
    written.put('project', 'project', 'project', {id: 'project', name: 'Test'});
    const meeting = {...f.store.get<Meeting>('meeting', 'meeting')!, startedAt: Date.now() - 60_000};
    written.put('meeting', 'meeting', 'project', {...meeting, status: 'live'});
    written.put('meeting', 'ended', 'project', {...meeting, id: 'ended', status: 'ended', endedAt: Date.now()});
    written.put('meeting', 'paused', 'project', {...meeting, id: 'paused', status: 'paused'});
    written.put('meeting', 'demo', 'project', {...meeting, id: 'demo', status: 'live', demo: true});
    written.finalSegment('meeting', segment());
  } finally {
    written.close();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = new Store(dbPath);
    const hub = new LiveHub(reopened, f.providers, dir);
    try {
      assert.equal(reopened.get<Meeting>('meeting', 'meeting')?.status, 'paused');
      const segments = reopened.list<Segment>('segment', 'meeting');
      assert.equal(segments.find(s => !s.gap)?.text, segment().text);
      const gaps = segments.filter(s => s.gap);
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0].startMs, segment().endMs);
      assert.equal(reopened.get<Meeting>('meeting', 'ended')?.status, 'ended');
      assert.equal(reopened.get<Meeting>('meeting', 'paused')?.status, 'paused');
      assert.equal(reopened.get<Meeting>('meeting', 'demo')?.status, 'paused');
      for (const mid of ['ended', 'paused', 'demo']) assert.equal(reopened.list('segment', mid).length, 0);
    } finally {
      hub.close();
      reopened.close();
    }
  }
});

test('reopening during pending ASR tail finalization records a gap for the interrupted audio', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-interrupted-finalization-'));
  const dbPath = join(dir, 'vc.sqlite');
  const f = fixture(t, dbPath);
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  await f.command('start');
  let finish: () => void = () => {};
  f.sessions[0].finish = () => new Promise<void>(resolve => { finish = resolve; });
  const stopping = f.command('stop');
  await Promise.resolve();
  f.hub.close();
  finish();
  await stopping;
  const reopened = new Store(dbPath);
  const hub = new LiveHub(reopened, f.providers, dir);
  try {
    const snapshot = reopened.snapshot('meeting', 'user');
    assert.equal(snapshot.meeting.status, 'paused');
    assert.equal(snapshot.segments.filter(s => s.gap).length, 1);
  } finally {
    hub.close();
    reopened.close();
  }
});

for(const fails of [false,true])test(`search sources remain visible while Chinese research is pending or ${fails?'unavailable':'ready'}`,async t=>{
 const f=fixture(t);
 const query='RAG benchmark';
 const evidence={id:'source',title:'Benchmark',url:'https://example.test/benchmark',snippet:'The report covers English datasets.',retrievedAt:10,query};
 const finding={sourceId:evidence.id,quote:'covers English datasets',point:'报告覆盖英文数据集。',relevance:'可参考其评测口径。',uncertainty:'摘要未说明是否适用于中文。'};
 const question={id:'question',text:'如何评估？',reason:'核对语种',quote:'语言',segmentIds:[],status:'new' as const,evidenceIds:[],createdAt:1,kind:'inference' as const};
 f.store.put('question','meeting:question','meeting',question);
 let release!:()=>void;
 const pending=new Promise<void>(resolve=>{release=resolve;});
 f.providers.researchTopic=async()=>[evidence];
 f.providers.summarizeResearch=async()=>{
  await pending;
  if(fails)throw new Error('test failure');
  return [finding];
 };
 const researching=f.hub.research('meeting',question,query);
 await settleMessages();
 const during=f.store.snapshot('meeting','user');
 assert.deepEqual(during.evidence,[evidence]);
 assert.deepEqual(during.questions[0].evidenceIds,[evidence.id]);
 assert.ok(!during.researchBriefs?.length);
 assert.deepEqual(f.socket.messages.filter(message=>message.type==='snapshot').at(-1)?.data.evidence,[evidence]);
 release();
 await researching;
 const after=f.store.snapshot('meeting','user');
 assert.deepEqual(after.evidence,[evidence]);
 assert.equal(after.researchBriefs?.[0].query,query);
 assert.equal(after.researchBriefs?.[0].status,fails?'unavailable':'ready');
 assert.deepEqual(after.researchBriefs?.[0].findings,fails?[]:[finding]);
 assert.equal(f.socket.messages.filter(message=>message.type==='snapshot').at(-1)?.data.researchBriefs[0].status,fails?'unavailable':'ready');
});

test('live analysis accumulates unique final text and spaces rounds 30 seconds apart',async t=>{
  const f=fixture(t);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:60_000});
  f.providers.getCapabilities=()=>({asr:true,deepseek:true,model:'test',version:'test'});
  const calls:AnalysisInput[]=[];
  f.providers.analyzeContext=async input=>{calls.push(input);return {questions:[]};};
  await f.command('start');
  const {onSegment}=f.sessions[0].callbacks;
  onSegment({...segment('partial'),text:'甲'.repeat(100),final:false});
  onSegment({...segment('a'),text:'甲'.repeat(40)});
  onSegment({...segment('a'),text:'甲'.repeat(50)});
  t.mock.timers.tick(0);
  assert.equal(calls.length,0);
  onSegment({...segment('b'),text:'乙'.repeat(31)});
  t.mock.timers.tick(0);
  await settleMessages();
  assert.deepEqual(calls.map(input=>input.newSegmentIds),[['a','b']]);
  onSegment({...segment('c'),text:'丙'.repeat(100)});
  t.mock.timers.tick(29_999);
  assert.equal(calls.length,1);
  t.mock.timers.tick(1);
  await settleMessages();
  assert.deepEqual(calls.map(input=>input.newSegmentIds),[['a','b'],['c']]);
  assert.ok(f.socket.messages.some(m=>m.stage==='coach'&&m.message==='已梳理，暂无值得打断的追问'));
});

for(const change of ['material','preparation','comment'] as const)test(`coaching checks source changes while a draft is pending: ${change}`,async t=>{
  const f=fixture(t);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:60_000});
  f.providers.getCapabilities=()=>({asr:true,deepseek:true,model:'test',version:'test'});
  const material:Material={id:'bp',projectId:'project',name:'BP.txt',createdAt:1,status:'ready',summary:'公司正在试点。',pages:[{page:1,text:'公司有三个试点客户。'}]};
  f.store.put('material',material.id,'project',material);
  const preparationQuestion={
    text:'试点客户有何共同条件？',why:'判断试点结果是否可推广。',evidenceWanted:'客户行业与部署方式。',
    source:{materialId:material.id,page:1,quote:'公司有三个试点客户。'},
  };
  const originalPreparation:StoredPreparation={
    revision:'original',sourceDigest:preparationSourceDigest([material]),
    preparation:{generatedAt:1,inspectedPages:1,totalPages:1,excerpted:false,overview:{},hypotheses:{},questions:[preparationQuestion]},
  };
  f.store.put('projectPreparation','project','project',originalPreparation);
  let release!:()=>void;
  const firstRound=new Promise<void>(resolve=>{release=resolve;});
  const calls:AnalysisInput[]=[];
  f.providers.analyzeContext=async input=>{
    calls.push(input);
    const first=input.newSegmentIds?.includes('pilot');
    if(first)await firstRound;
    return {questions:[{
      text:first?'有多少试点已经付费？':'单次交付需要多少工时？',
      reason:'核对项目经济性。',quote:input.materials[0].pages[0].text,
      materialId:material.id,materialPage:1,segmentIds:input.newSegmentIds!,
      focus:first?'customer_evidence':'unit_economics',researchQuery:first?'RAG benchmark':'ASR accuracy',
    }]};
  };
  const searches:string[]=[];
  f.providers.researchTopic=async query=>{
    searches.push(query);
    return [{id:query,title:'Reference',url:'https://example.test/research',snippet:'Public research.',retrievedAt:1,query}];
  };
  await f.command('start');
  const {onSegment}=f.sessions[0].callbacks;
  onSegment({...segment('pilot'),text:'讨论客户试点的情况。'.repeat(12)});
  t.mock.timers.tick(0);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].preparation,originalPreparation.preparation);
  if(change==='material'){
    f.store.put('material',material.id,'project',{...material,pages:[{page:1,text:'经核实只有一家试点客户。'}]});
  }else if(change==='preparation'){
    f.store.put('projectPreparation','project','project',{
      ...originalPreparation,revision:'updated',
      preparation:{...originalPreparation.preparation,questions:[{...preparationQuestion,text:'如何区分试点和有效部署？'}]},
    });
  }else{
    f.store.put('comment','meeting:comment','meeting',{id:'comment',userId:'user',userName:'Host',text:'会上记录',private:false,createdAt:2});
  }
  release();
  await settleMessages();
  const unaffected=change==='comment';
  assert.deepEqual(f.store.snapshot('meeting','user').questions.map(q=>q.text),unaffected?['有多少试点已经付费？']:[]);
  assert.deepEqual(searches,unaffected?['RAG benchmark']:[]);
  onSegment({...segment('delivery'),text:'讨论客户部署和交付工时。'.repeat(12)});
  t.mock.timers.tick(30_000);
  await settleMessages();
  assert.deepEqual(calls.map(input=>input.newSegmentIds),[['pilot'],['delivery']]);
  if(change==='material')assert.equal(calls[1].preparation,undefined);
  if(change==='preparation')assert.equal(calls[1].preparation?.questions[0].text,'如何区分试点和有效部署？');
  const published=f.store.snapshot('meeting','user');
  assert.deepEqual(published.questions.map(q=>q.text),unaffected?['有多少试点已经付费？','单次交付需要多少工时？']:['单次交付需要多少工时？']);
  assert.deepEqual(published.evidence.map(e=>e.query),unaffected?['RAG benchmark','ASR accuracy']:['ASR accuracy']);
});

for(const action of ['pause','stop'] as const) test(`analysis on ${action} includes the confirmed tail without delaying recording control`,async t=>{
  const f=fixture(t);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:60_000});
  f.providers.getCapabilities=()=>({asr:true,deepseek:true,model:'test',version:'test'});
  const calls:AnalysisInput[]=[];
  let releaseAI!:()=>void;
  const firstRound=new Promise<void>(resolve=>{releaseAI=resolve;});
  f.providers.analyzeContext=async input=>{calls.push(input);if(calls.length===1)await firstRound;return {questions:[]};};
  await f.command('start');
  const session=f.sessions[0];
  session.callbacks.onSegment({...segment('first'),text:'经营信息'.repeat(24)});
  t.mock.timers.tick(0);
  assert.equal(calls.length,1);
  session.finish=async()=>{session.callbacks.onSegment({...segment('tail'),text:'刚才说的是客户试点'});};
  await f.command(action);
  assert.equal(calls.length,1);
  assert.equal(f.store.snapshot('meeting','user').meeting.status,action==='pause'?'paused':'ended');
  releaseAI();
  await settleMessages();
  t.mock.timers.tick(0);
  await settleMessages();
  assert.deepEqual(calls.map(input=>input.newSegmentIds),[['first'],['tail']]);
  await f.command('stop');
  t.mock.timers.tick(30_000);
  assert.equal(calls.length,2);
});

test('coaching keeps one question per round and suppresses reworded questions about the same evidence and focus',async t=>{
  const f=fixture(t);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:60_000});
  f.providers.getCapabilities=()=>({asr:true,deepseek:true,model:'test',version:'test'});
  const quote='我们有三个试点客户';
  const first={text:'有几个试点已签付费合同？',reason:'区分试点意向和已经验证的付费需求。',quote,segmentIds:['pilot'],focus:'customer_evidence' as const};
  const repeated={...first,text:'这几个客户的试点有多少从免费变成了实际付费？',segmentIds:['repeat']};
  const distinct={...first,text:'跑通试点后每部署一个客户需要投入多少实施工时？',reason:'判断扩张时实施成本会不会压缩毛利。',segmentIds:['cost'],focus:'unit_economics' as const};
  const rounds=[[first,{...first,text:'其他问题'}],[repeated],[distinct],[]];
  f.providers.analyzeContext=async()=>({questions:rounds.shift()!});
  await f.command('start');
  for(const id of ['pilot','repeat','cost','empty']){
    f.sessions[0].callbacks.onSegment({...segment(id),text:quote+'。其他背景信息。'.repeat(12)});
    t.mock.timers.tick(30_000);
    await settleMessages();
  }
  assert.deepEqual(f.store.snapshot('meeting','user').questions.map(q=>q.text),[first.text,distinct.text]);
});

function addResearchQuestion(f: ReturnType<typeof fixture>, id:string){
 const question={id,text:'如何评估？',reason:'核对语种',quote:'语言',segmentIds:[],status:'new' as const,evidenceIds:[],createdAt:1,kind:'inference' as const};
 f.store.put('question',`meeting:${id}`,'meeting',question);
 return question;
}

test('follow-up analysis receives previously collected research only from its own meeting', t=>{
 const f=fixture(t),query='RAG benchmark';
 const source={id:'source',title:'Report',url:'https://example.test/report',snippet:'English only',retrievedAt:10,query};
 const brief={query,status:'ready',updatedAt:11,findings:[{sourceId:source.id,quote:'English only',point:'仅英文',relevance:'评测边界',uncertainty:'中文待验证'}]};
 f.store.put('evidence','meeting:source','meeting',source);
 f.store.put('researchBrief','meeting:query','meeting',brief);
 f.store.put('evidence','another:secret','another-meeting',{...source,id:'other-source'});
 f.store.put('researchBrief','another:query','another-meeting',{...brief,query:'ASR'});
 const input=f.hub.input('meeting');
 assert.deepEqual(input.evidence,[source]);
 assert.deepEqual(input.researchBriefs,[brief]);
});

test('questions share one in-flight public search and reuse its sources and brief',async t=>{
 const f=fixture(t),query='RAG benchmark';
 const source={id:'shared-source',title:'Report',url:'https://example.test/report',snippet:'English only',retrievedAt:10,query};
 let release!:()=>void,searchCalls=0,briefCalls=0;
 const pending=new Promise<void>(resolve=>{release=resolve;});
 f.providers.researchTopic=async()=>{searchCalls++;await pending;return [source];};
 const finding={sourceId:source.id,quote:'English only',point:'仅限英文。',relevance:'评测范围。',uncertainty:'中文待核实。'};
 f.providers.summarizeResearch=async()=>{briefCalls++;return [finding];};
 const first=f.hub.research('meeting',addResearchQuestion(f,'first'),query);
 const second=f.hub.research('meeting',addResearchQuestion(f,'second'),query);
 release();
 await Promise.all([first,second]);
 await f.hub.research('meeting',addResearchQuestion(f,'third'),query);
 const snap=f.store.snapshot('meeting','user');
 assert.equal(searchCalls,1);
 assert.equal(briefCalls,1);
 assert.deepEqual(snap.questions.map(question=>question.evidenceIds),[[source.id],[source.id],[source.id]]);
 assert.equal(snap.researchBriefs?.length,1);
 assert.deepEqual(snap.researchBriefs?.[0].findings,[finding]);
});

for(const miss of ['empty','error'] as const)test(`a later question can retry research after ${miss} with throttling`,async t=>{
 const f=fixture(t),query='RAG benchmark';
 const source={id:'retry-source',title:'Report',url:'https://example.test/report',snippet:'English only',retrievedAt:10,query};
 let now=Date.now(),calls=0;
 t.mock.method(Date,'now',()=>now);
 f.providers.researchTopic=async()=>{
  if(++calls>1)return [source];
  if(miss==='error')throw new Error('transient failure');
  return [];
 };
 await f.hub.research('meeting',addResearchQuestion(f,'first'),query);
 await f.hub.research('meeting',addResearchQuestion(f,'second'),query);
 assert.equal(calls,1);
 now+=30001;
 await f.hub.research('meeting',addResearchQuestion(f,'third'),query);
 assert.equal(calls,2);
 assert.deepEqual(f.store.snapshot('meeting','user').questions.map(question=>question.evidenceIds),[[source.id],[source.id],[source.id]]);
});

test('analysis finishing after deletion does not recreate orphan questions',async t=>{
  const f=fixture(t);
  t.mock.timers.enable({apis:['Date','setTimeout'],now:60_000});
  f.providers.getCapabilities=()=>({asr:true,deepseek:true,model:'test',version:'test'});
  let resolve!:(value:any)=>void;
  f.providers.analyzeContext=()=>new Promise(r=>{resolve=r;});
  await f.command('start');
  f.sessions[0].callbacks.onSegment({...segment(),text:'经营信息'.repeat(24)});
  t.mock.timers.tick(0);
  f.store.deleteScope('meeting');f.store.deleteScope('project');
  resolve({questions:[{text:'orphan',reason:'test',quote:'test',segmentIds:[]}]});
  await settleMessages();
  assert.equal(f.store.list('question','meeting').length,0);
});
