import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Store} from '../server/store';
import {LiveHub} from '../server/live';
import type {ASRCallbacks,ProviderAPI} from '../server/providers/contracts';
import type {Meeting,Segment} from '../shared/types';

class Socket extends EventEmitter {
  readyState=1; bufferedAmount=0; messages:any[]=[];
  send(raw:string){this.messages.push(JSON.parse(raw));}
  close(){this.readyState=3;this.emit('close');}
}
function fixture(t:any) {
  const store=new Store(':memory:');
  const user={id:'user',name:'Host',email:'host@example.com'};
  store.put('project','project','project',{id:'project',name:'Test'});
  store.put('member','project:user','project',{role:'admin'});
  const meeting:Meeting={id:'meeting',projectId:'project',title:'test',mode:'offline',demo:false,status:'ready',createdAt:Date.now(),ownerId:'user',retainAudio:false};
  store.put('meeting','meeting','project',meeting);
  const sessions:Array<{callbacks:ASRCallbacks;writes:Buffer[];closed:boolean;finish:()=>Promise<void>;close:()=>void;write:(b:Buffer)=>void}>=[];
  const providers:ProviderAPI={getCapabilities:()=>({asr:true,deepseek:false,model:'test',version:'test'}),analyzeContext:async()=>({questions:[]}),researchTopic:async()=>[],summarizeMeeting:async()=>'',summarizeMaterial:async()=>'',createASR(callbacks){
    const session={callbacks,writes:[] as Buffer[],closed:false,finish:async()=>{},close(){this.closed=true;},write(b:Buffer){this.writes.push(b);}};
    sessions.push(session); return session;
  }};
  const hub=new LiveHub(store,providers,'.');
  const socket=new Socket();hub.attach(socket as any,user,'meeting');
  const peer={socket:socket as any,user,mid:'meeting'};
  t.after(()=>{hub.close();store.close();});
  return {store,hub,sessions,peer,socket,user,providers,command:(type:string)=>hub.command(peer,JSON.stringify({type}))};
}
const segment=(id='sentence'):Segment=>({id,text:'最后一句完整语音',speaker:'speaker_0',startMs:0,endMs:1000,receivedAt:Date.now(),source:'asr',final:true});

test('pause finishes provider tail before closing; duplicate final does not schedule coaching twice',async t=>{
  const f=fixture(t);await f.command('start');
  let scheduled=0; f.hub.schedule=()=>{scheduled++;};
  f.sessions[0].finish=async()=>{f.sessions[0].callbacks.onSegment(segment());f.sessions[0].callbacks.onSegment(segment());};
  await f.command('pause');
  assert.equal(f.store.snapshot('meeting','user').segments.length,1);
  assert.equal(scheduled,1);
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
  await assert.rejects(f.hub.command(peer,JSON.stringify({type:'pause'})), /窗口|收音|连接/);
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

test('analysis finishing after deletion does not recreate orphan questions',async t=>{
  const f=fixture(t);
  let resolve!:(value:any)=>void;
  f.providers.analyzeContext=()=>new Promise(r=>{resolve=r;});
  const pending=f.hub.analyze('meeting');
  f.store.deleteScope('meeting');f.store.deleteScope('project');
  resolve({questions:[{text:'orphan',reason:'test',quote:'test',segmentIds:[]}]});await pending;
  assert.equal(f.store.list('question','meeting').length,0);
});
