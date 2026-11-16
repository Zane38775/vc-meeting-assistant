import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtemp,rm,readdir} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {createApp} from '../server/app';
test('packaged service serves assets from explicit CLIENT_DIR independent of process cwd',async t=>{
 const {writeFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'vc-client-'));const previous=process.env.CLIENT_DIR;process.env.CLIENT_DIR=dir;
 await writeFile(join(dir,'index.html'),'<html><title>packaged-client</title></html>');
 t.after(async()=>{if(previous===undefined)delete process.env.CLIENT_DIR;else process.env.CLIENT_DIR=previous;await rm(dir,{recursive:true,force:true})});
 const app=await createApp({dbPath:':memory:',dataDir:join(dir,'data'),providers});await app.ready();
 const result=await app.inject({url:'/'});assert.equal(result.statusCode,200);assert.ok(result.body.includes('packaged-client'));await app.close();
});
import {Store} from '../server/store';
import type {ASRCallbacks,ProviderAPI} from '../server/providers/contracts';
const providers={getCapabilities:()=>({deepseek:false,asr:false,model:'test',version:'0.1'}),analyzeContext:async()=>({questions:[]}),researchTopic:async()=>[],summarizeMeeting:async()=> '纪要',summarizeMaterial:async()=> '摘要',createASR:()=>{throw Error('未配置语音服务')}};
async function setup(t:any) {const dir=await mkdtemp(join(tmpdir(),'vc-test-'));const app=await createApp({dbPath:':memory:',dataDir:dir,providers});await app.ready();t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true})});return app;}
async function register(app:any,email:string){const res=await app.inject({method:'POST',url:'/api/auth/register',payload:{email,password:'a-strong-password',name:email.split('@')[0]}});assert.equal(res.statusCode,200,res.body);return {cookie:res.headers['set-cookie'].split(';')[0],user:res.json().user};}
async function project(app:any,cookie:string){const r=await app.inject({method:'POST',url:'/api/projects',headers:{cookie},payload:{name:'项目A'}});assert.equal(r.statusCode,200,r.body);return r.json().project.id;}
async function meeting(app:any,cookie:string,pid:string){const r=await app.inject({method:'POST',url:`/api/projects/${pid}/meetings`,headers:{cookie},payload:{title:'会议',mode:'offline',demo:true}});assert.equal(r.statusCode,200,r.body);return r.json().meeting.id;}
test('private projects reject guessed IDs and revoked sessions',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const b=await register(app,'b@example.com');const pid=await project(app,a.cookie);assert.equal((await app.inject({url:`/api/projects/${pid}`,headers:{cookie:b.cookie}})).statusCode,403);assert.equal((await app.inject({url:'/api/projects'})).statusCode,401);await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:a.cookie}});assert.equal((await app.inject({url:'/api/projects',headers:{cookie:a.cookie}})).statusCode,401);});
test('invites are single use; private notes and unpublished summaries stay private',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const b=await register(app,'b@example.com');const pid=await project(app,a.cookie);const mid=await meeting(app,a.cookie,pid);let r=await app.inject({method:'POST',url:`/api/projects/${pid}/invites`,headers:{cookie:a.cookie},payload:{role:'viewer'}});const token=r.json().token;assert.ok(token);r=await app.inject({method:'POST',url:'/api/invites/accept',headers:{cookie:b.cookie},payload:{token}});assert.equal(r.statusCode,200,r.body);assert.equal((await app.inject({method:'POST',url:'/api/invites/accept',headers:{cookie:b.cookie},payload:{token}})).statusCode,400);await app.inject({method:'POST',url:`/api/meetings/${mid}/comments`,headers:{cookie:a.cookie},payload:{text:'私密判断',private:true}});await app.inject({method:'POST',url:`/api/meetings/${mid}/comments`,headers:{cookie:a.cookie},payload:{text:'公开信息',private:false}});await app.inject({method:'PATCH',url:`/api/meetings/${mid}/summary`,headers:{cookie:a.cookie},payload:{text:'草稿判断',published:false}});r=await app.inject({url:`/api/meetings/${mid}`,headers:{cookie:b.cookie}});assert.deepEqual(r.json().comments.map((x:any)=>x.text),['公开信息']);assert.equal(r.json().summary,null);assert.equal((await app.inject({method:'PATCH',url:`/api/meetings/${mid}/summary`,headers:{cookie:b.cookie},payload:{text:'篡改',published:true}})).statusCode,403);});
test('cross origin mutations rejected and failed real start cannot become demo',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const r=await app.inject({method:'POST',url:'/api/projects',headers:{cookie:a.cookie,origin:'https://evil.example'},payload:{name:'x'}});assert.equal(r.statusCode,403);const pid=await project(app,a.cookie);const m=await app.inject({method:'POST',url:`/api/projects/${pid}/meetings`,headers:{cookie:a.cookie},payload:{title:'Real',mode:'online',demo:false}});const mid=m.json().meeting.id;const snap=await app.inject({url:`/api/meetings/${mid}`,headers:{cookie:a.cookie}});assert.equal(snap.json().meeting.demo,false);});
test('revocation disconnects a real subscribed socket and removes all access',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const b=await register(app,'b@example.com');const pid=await project(app,a.cookie);const mid=await meeting(app,a.cookie,pid);const inv=await app.inject({method:'POST',url:`/api/projects/${pid}/invites`,headers:{cookie:a.cookie},payload:{role:'viewer'}});await app.inject({method:'POST',url:'/api/invites/accept',headers:{cookie:b.cookie},payload:{token:inv.json().token}});await app.listen({host:'127.0.0.1',port:0});const address=app.server.address() as any;const ws=new WebSocket(`ws://127.0.0.1:${address.port}/api/meetings/${mid}/live`,{headers:{cookie:b.cookie}});t.after(()=>ws.terminate());await new Promise<void>((res,rej)=>{ws.once('open',res);ws.once('error',rej)});const closed=new Promise<number>(res=>ws.once('close',res));assert.equal((await app.inject({method:'DELETE',url:`/api/projects/${pid}/members/${b.user.id}`,headers:{cookie:a.cookie}})).statusCode,200);assert.equal(await closed,4003);assert.equal((await app.inject({url:`/api/meetings/${mid}`,headers:{cookie:b.cookie}})).statusCode,403);});
test('only the local first user can configure provider secrets; responses never echo keys',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const b=await register(app,'b@example.com');const prior=process.env.DEEPSEEK_API_KEY;t.after(()=>{if(prior===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=prior});const key='sk-test-only-not-a-real-key';let r=await app.inject({method:'POST',url:'/api/settings',headers:{cookie:b.cookie},payload:{deepseekApiKey:key}});assert.equal(r.statusCode,403);r=await app.inject({method:'POST',url:'/api/settings',headers:{cookie:a.cookie},remoteAddress:'203.0.113.2',payload:{deepseekApiKey:key}});assert.equal(r.statusCode,403);r=await app.inject({method:'POST',url:'/api/settings',headers:{cookie:a.cookie},payload:{deepseekApiKey:key}});assert.equal(r.statusCode,200,r.body);assert.equal(r.body.includes(key),false);assert.equal(r.json().deepseekConfigured,true);assert.equal((await app.inject({url:'/api/settings',headers:{cookie:b.cookie}})).json().canManageSettings,false);});

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function uploadText(app:any,cookie:string,pid:string){
 const boundary='material-regression-boundary';
 const payload=`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.txt"\r\nContent-Type: text/plain\r\n\r\nPrivate project material\r\n--${boundary}--\r\n`;
 return app.inject({method:'POST',url:`/api/projects/${pid}/materials`,headers:{cookie,'content-type':`multipart/form-data; boundary=${boundary}`},payload}).then((r:any)=>r);
}
async function snapshotWhen(app:any,cookie:string,mid:string,predicate:(snapshot:any)=>boolean){
 const deadline=Date.now()+2000;
 do{const r=await app.inject({url:`/api/meetings/${mid}`,headers:{cookie}});assert.equal(r.statusCode,200,r.body);const value=r.json();if(predicate(value))return value;await new Promise(r=>setTimeout(r,5));}while(Date.now()<deadline);
 throw new Error('Expected meeting state did not arrive');
}

for(const command of ['pause','stop'] as const)test(`summary waits for ${command} to finish its final ASR sentence`,{timeout:8000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vc-summary-tail-'));
 const started=deferred(),finishing=deferred(),release=deferred();let callbacks!:ASRCallbacks;
 const fake:ProviderAPI={...providers,getCapabilities:()=>({deepseek:true,asr:true,model:'test',version:'test'}),
  summarizeMeeting:async input=>input.segments.map(s=>s.text).join('|'),
  createASR(cb){callbacks=cb;started.resolve();return {write(){},close(){},async finish(){finishing.resolve();await release.promise;callbacks.onSegment({id:'tail',text:'last sentence',speaker:'speaker',startMs:1000,endMs:2000,receivedAt:Date.now(),final:true,source:'asr'});}};}};
 const app=await createApp({dbPath:':memory:',dataDir:dir,providers:fake});await app.listen({port:0,host:'127.0.0.1'});
 let ws:WebSocket|undefined;
 t.after(async()=>{release.resolve();ws?.terminate();await app.close();await rm(dir,{recursive:true,force:true});});
 const a=await register(app,'tail@example.com'),pid=await project(app,a.cookie);
 const m=await app.inject({method:'POST',url:`/api/projects/${pid}/meetings`,headers:{cookie:a.cookie},payload:{title:'Real',demo:false}});const mid=m.json().meeting.id;
 ws=new WebSocket(`ws://127.0.0.1:${(app.server.address() as any).port}/api/meetings/${mid}/live`,{headers:{cookie:a.cookie}});
 await new Promise<void>((resolve,reject)=>{ws!.once('open',resolve);ws!.once('error',reject);});
 ws.send(JSON.stringify({type:'start'}));await started.promise;
 callbacks.onSegment({id:'early',text:'early sentence',speaker:'speaker',startMs:0,endMs:1000,receivedAt:Date.now(),final:true,source:'asr'});
 ws.send(JSON.stringify({type:command}));await finishing.promise;
 const pending=await app.inject({method:'POST',url:`/api/meetings/${mid}/summary`,headers:{cookie:a.cookie}});
 assert.equal(pending.statusCode,409,'Cannot summarize while the provider still holds the final sentence');
 assert.equal((await app.inject({url:`/api/meetings/${mid}`,headers:{cookie:a.cookie}})).json().summary,null);
 release.resolve();
 await snapshotWhen(app,a.cookie,mid,s=>s.meeting.status===(command==='pause'?'paused':'ended')&&s.segments.length===2);
 const complete=await app.inject({method:'POST',url:`/api/meetings/${mid}/summary`,headers:{cookie:a.cookie}});
 assert.equal(complete.statusCode,200,complete.body);assert.equal(complete.json().summary.text,'early sentence|last sentence');
});

test('upload finishing after project deletion removes its private file and cannot recreate material',{timeout:8000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vc-upload-deleted-'));const app=await createApp({dataDir:dir,providers});await app.ready();
 const written=deferred(),release=deferred();const original=fs.writeFile;
 // Preserve the real disk write, but hold its completion at the race boundary.
 fs.writeFile=(async(...args:any[])=>{await (original as any)(...args);if(String(args[0]).startsWith(join(dir,'files'))){written.resolve();await release.promise;}}) as typeof fs.writeFile;syncBuiltinESMExports();
 t.after(async()=>{release.resolve();fs.writeFile=original;syncBuiltinESMExports();await app.close();await rm(dir,{recursive:true,force:true});});
 const a=await register(app,'delete@example.com'),pid=await project(app,a.cookie);
 const uploading=uploadText(app,a.cookie,pid);await written.promise;
 assert.equal((await app.inject({method:'DELETE',url:`/api/projects/${pid}`,headers:{cookie:a.cookie}})).statusCode,200);
 release.resolve();const response=await uploading;
 assert.equal(response.statusCode,404,response.body);
 const db=new Store(join(dir,'vc.sqlite'));
 try{assert.equal(db.get('project',pid),undefined);assert.deepEqual(db.list('material',pid),[]);}finally{db.close();}
 assert.deepEqual(await readdir(join(dir,'files')),[]);
});

test('project deletion revokes uploads before waiting for existing file cleanup',{timeout:8000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vc-delete-cleanup-'));const app=await createApp({dataDir:dir,providers});await app.ready();
 const a=await register(app,'cleanup@example.com'),pid=await project(app,a.cookie);
 const uploaded=await uploadText(app,a.cookie,pid);assert.equal(uploaded.statusCode,200,uploaded.body);
 const file=join(dir,'files',uploaded.json().material.id),cleaning=deferred(),release=deferred(),original=fs.unlink;
 fs.unlink=async path=>{if(String(path)===file){cleaning.resolve();await release.promise;}return original(path);};syncBuiltinESMExports();
 t.after(async()=>{release.resolve();fs.unlink=original;syncBuiltinESMExports();await app.close();await rm(dir,{recursive:true,force:true});});
 const deletion=app.inject({method:'DELETE',url:`/api/projects/${pid}`,headers:{cookie:a.cookie}}).then(r=>r);await cleaning.promise;
 const lateUpload=await uploadText(app,a.cookie,pid);
 release.resolve();assert.equal((await deletion).statusCode,200);
 assert.equal(lateUpload.statusCode,403,lateUpload.body);
 assert.deepEqual(await readdir(join(dir,'files')),[]);
});
