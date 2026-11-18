import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtemp,rm,readdir} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {strToU8,zipSync} from 'fflate';
import {parse as parseEnv} from 'dotenv';
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
async function setup(t:any,appProviders:ProviderAPI=providers) {const dir=await mkdtemp(join(tmpdir(),'vc-test-'));const app=await createApp({dbPath:':memory:',dataDir:dir,providers:appProviders});await app.ready();t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true})});return app;}
async function register(app:any,email:string){const res=await app.inject({method:'POST',url:'/api/auth/register',payload:{email,password:'a-strong-password',name:email.split('@')[0]}});assert.equal(res.statusCode,200,res.body);return {cookie:res.headers['set-cookie'].split(';')[0],user:res.json().user};}
async function project(app:any,cookie:string){const r=await app.inject({method:'POST',url:'/api/projects',headers:{cookie},payload:{name:'项目A'}});assert.equal(r.statusCode,200,r.body);return r.json().project.id;}
async function meeting(app:any,cookie:string,pid:string){const r=await app.inject({method:'POST',url:`/api/projects/${pid}/meetings`,headers:{cookie},payload:{title:'会议',mode:'offline',demo:true}});assert.equal(r.statusCode,200,r.body);return r.json().meeting.id;}
test('private projects reject guessed IDs and revoked sessions',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const b=await register(app,'b@example.com');const pid=await project(app,a.cookie);assert.equal((await app.inject({url:`/api/projects/${pid}`,headers:{cookie:b.cookie}})).statusCode,403);assert.equal((await app.inject({url:'/api/projects'})).statusCode,401);await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie:a.cookie}});assert.equal((await app.inject({url:'/api/projects',headers:{cookie:a.cookie}})).statusCode,401);});
test('invites are single use; private notes and unpublished summaries stay private',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const b=await register(app,'b@example.com');const pid=await project(app,a.cookie);const mid=await meeting(app,a.cookie,pid);let r=await app.inject({method:'POST',url:`/api/projects/${pid}/invites`,headers:{cookie:a.cookie},payload:{role:'viewer'}});const token=r.json().token;assert.ok(token);r=await app.inject({method:'POST',url:'/api/invites/accept',headers:{cookie:b.cookie},payload:{token}});assert.equal(r.statusCode,200,r.body);assert.equal((await app.inject({method:'POST',url:'/api/invites/accept',headers:{cookie:b.cookie},payload:{token}})).statusCode,400);await app.inject({method:'POST',url:`/api/meetings/${mid}/comments`,headers:{cookie:a.cookie},payload:{text:'私密判断',private:true}});await app.inject({method:'POST',url:`/api/meetings/${mid}/comments`,headers:{cookie:a.cookie},payload:{text:'公开信息',private:false}});await app.inject({method:'PATCH',url:`/api/meetings/${mid}/summary`,headers:{cookie:a.cookie},payload:{text:'草稿判断',published:false}});r=await app.inject({url:`/api/meetings/${mid}`,headers:{cookie:b.cookie}});assert.deepEqual(r.json().comments.map((x:any)=>x.text),['公开信息']);assert.equal(r.json().summary,null);assert.equal((await app.inject({method:'PATCH',url:`/api/meetings/${mid}/summary`,headers:{cookie:b.cookie},payload:{text:'篡改',published:true}})).statusCode,403);});
test('cross origin mutations rejected and failed real start cannot become demo',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const r=await app.inject({method:'POST',url:'/api/projects',headers:{cookie:a.cookie,origin:'https://evil.example'},payload:{name:'x'}});assert.equal(r.statusCode,403);const pid=await project(app,a.cookie);const m=await app.inject({method:'POST',url:`/api/projects/${pid}/meetings`,headers:{cookie:a.cookie},payload:{title:'Real',mode:'online',demo:false}});const mid=m.json().meeting.id;const snap=await app.inject({url:`/api/meetings/${mid}`,headers:{cookie:a.cookie}});assert.equal(snap.json().meeting.demo,false);});
test('revocation disconnects a real subscribed socket and removes all access',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const b=await register(app,'b@example.com');const pid=await project(app,a.cookie);const mid=await meeting(app,a.cookie,pid);const inv=await app.inject({method:'POST',url:`/api/projects/${pid}/invites`,headers:{cookie:a.cookie},payload:{role:'viewer'}});await app.inject({method:'POST',url:'/api/invites/accept',headers:{cookie:b.cookie},payload:{token:inv.json().token}});await app.listen({host:'127.0.0.1',port:0});const address=app.server.address() as any;const ws=new WebSocket(`ws://127.0.0.1:${address.port}/api/meetings/${mid}/live`,{headers:{cookie:b.cookie}});t.after(()=>ws.terminate());await new Promise<void>((res,rej)=>{ws.once('open',res);ws.once('error',rej)});const closed=new Promise<number>(res=>ws.once('close',res));assert.equal((await app.inject({method:'DELETE',url:`/api/projects/${pid}/members/${b.user.id}`,headers:{cookie:a.cookie}})).statusCode,200);assert.equal(await closed,4003);assert.equal((await app.inject({url:`/api/meetings/${mid}`,headers:{cookie:b.cookie}})).statusCode,403);});
test('only the local first user can configure provider secrets; responses never echo keys',async t=>{const app=await setup(t);const a=await register(app,'a@example.com');const b=await register(app,'b@example.com');const prior=process.env.DEEPSEEK_API_KEY;t.after(()=>{if(prior===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=prior});const key='sk-test-only-not-a-real-key';let r=await app.inject({method:'POST',url:'/api/settings',headers:{cookie:b.cookie},payload:{deepseekApiKey:key}});assert.equal(r.statusCode,403);r=await app.inject({method:'POST',url:'/api/settings',headers:{cookie:a.cookie},remoteAddress:'203.0.113.2',payload:{deepseekApiKey:key}});assert.equal(r.statusCode,403);r=await app.inject({method:'POST',url:'/api/settings',headers:{cookie:a.cookie},payload:{deepseekApiKey:key}});assert.equal(r.statusCode,200,r.body);assert.equal(r.body.includes(key),false);assert.equal(r.json().deepseekConfigured,true);assert.equal((await app.inject({url:'/api/settings',headers:{cookie:b.cookie}})).json().canManageSettings,false);});

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

test('local operator can save and clear transcription terms without exposing or replacing the key', async t => {
 const dir=await mkdtemp(join(tmpdir(),'vc-transcription-settings-'));
 const configPath=join(dir,'.env');
 const oldKey=process.env.DEEPSEEK_API_KEY,oldTerms=process.env.ASR_HOTWORDS;
 const app=await createApp({dbPath:':memory:',dataDir:dir,configPath,providers});
 t.after(async()=>{
  if(oldKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=oldKey;
  if(oldTerms===undefined)delete process.env.ASR_HOTWORDS;else process.env.ASR_HOTWORDS=oldTerms;
  await app.close();await rm(dir,{recursive:true,force:true});
 });
 const owner=await register(app,'terms-owner@example.com'),member=await register(app,'terms-member@example.com');
 const save=(payload:object,cookie=owner.cookie)=>app.inject({method:'POST',url:'/api/settings',headers:{cookie},payload});
 const key='sk-test-transcription-settings';
 const terms='home party\nace-step';
 const [keyResult,termsResult]=await Promise.all([save({deepseekApiKey:key}),save({transcriptionTerms:terms})]);
 assert.equal(keyResult.statusCode,200,keyResult.body);
 assert.equal(termsResult.statusCode,200,termsResult.body);
 assert.equal(termsResult.json().transcriptionTerms,terms);
 assert.equal(termsResult.body.includes(key),false);
 const env=parseEnv(await fs.readFile(configPath,'utf8'));
 assert.equal(env.DEEPSEEK_API_KEY,key);
 assert.equal(env.ASR_HOTWORDS,terms);
 const other=await app.inject({url:'/api/settings',headers:{cookie:member.cookie}});
 assert.equal(other.json().transcriptionTerms,undefined);
 assert.equal((await save({transcriptionTerms:'Replacement'},member.cookie)).statusCode,403);
 const invalidTerms=['HOME :99','HOME"\nPORT=22','x'.repeat(61),Array.from({length:21},()=> 'ordinary term').join('\n')];
 for(const term of invalidTerms)assert.equal((await save({transcriptionTerms:term})).statusCode,400,term);
 assert.equal((await save({transcriptionTerms:''})).statusCode,200);
 const cleared=parseEnv(await fs.readFile(configPath,'utf8'));
 assert.equal(cleared.ASR_HOTWORDS,'');
 assert.equal(cleared.DEEPSEEK_API_KEY,key);
});
function uploadText(app:any,cookie:string,pid:string,contents='Private project material'){
 const boundary='material-regression-boundary';
 const payload=`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.txt"\r\nContent-Type: text/plain\r\n\r\n${contents}\r\n--${boundary}--\r\n`;
 return app.inject({method:'POST',url:`/api/projects/${pid}/materials`,headers:{cookie,'content-type':`multipart/form-data; boundary=${boundary}`},payload}).then((r:any)=>r);
}
function uploadFile(app:Awaited<ReturnType<typeof createApp>>,cookie:string,pid:string,name:string,chunks:Iterable<Uint8Array>){
 const boundary='large-material-boundary';
 function* multipartBody(){
  yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  yield* chunks;
  yield Buffer.from(`\r\n--${boundary}--\r\n`);
 }
 return app.inject({method:'POST',url:`/api/projects/${pid}/materials`,headers:{cookie,'content-type':`multipart/form-data; boundary=${boundary}`},payload:Readable.from(multipartBody())});
}

test('project preparation is optional for older projects and automatically saved from this project on upload',async t=>{
 const calls:string[][]=[];
 const app=await setup(t,{...providers,getCapabilities:()=>({deepseek:true,asr:false,model:'test',version:'test'}),
  prepareProject:async input=>{
   calls.push(input.materials.map(m=>m.pages[0].text));
   const material=input.materials[0];
   return {overview:{product:{statement:'公司描述其工具用途。',source:{materialId:material.id,page:1,quote:material.pages[0].text}}},hypotheses:{},questions:[]};
  }});
 const admin=await register(app,'prep-owner@example.com'),outsider=await register(app,'prep-outsider@example.com');
 const otherId=await project(app,outsider.cookie),pid=await project(app,admin.cookie);
 await uploadText(app,outsider.cookie,otherId,'Another project only');
 const detail=()=>app.inject({url:`/api/projects/${pid}`,headers:{cookie:admin.cookie}}).then(r=>r.json());
 assert.equal((await detail()).preparation,undefined);
 const uploaded=await uploadText(app,admin.cookie,pid,'An enterprise support tool');
 assert.equal(uploaded.statusCode,200,uploaded.body);
 const record=await detail();
 assert.deepEqual(calls,[['Another project only'],['An enterprise support tool']]);
 assert.equal(record.materials[0].summary,'摘要');
 assert.equal(record.preparation.overview.product.source.materialId,record.materials[0].id);
 assert.equal(record.preparation.overview.product.source.quote,'An enterprise support tool');
 assert.equal(record.preparation.inspectedPages,1);
 assert.equal(record.preparation.totalPages,1);
 assert.equal((await app.inject({method:'POST',url:`/api/projects/${pid}/preparation`,headers:{cookie:outsider.cookie}})).statusCode,403);
});

test('project preparation preserves uploaded materials on AI failure and refuses results for concurrently changed pages',{timeout:8000},async t=>{
 const started=deferred(),release=deferred();
 let mode:'fail'|'wait'|'succeed'|'empty'='fail';
 const app=await setup(t,{...providers,getCapabilities:()=>({deepseek:true,asr:false,model:'test',version:'test'}),
  prepareProject:async input=>{
   if(mode==='fail')throw new Error('test failure');
   if(mode==='empty')return {overview:{},hypotheses:{},questions:[]};
   if(mode==='wait'){started.resolve();await release.promise;}
   const material=input.materials[0];
   return {overview:{product:{statement:'公司描述其工具用途。',source:{materialId:material.id,page:1,quote:material.pages[0].text}}},hypotheses:{},questions:[]};
  }});
 t.after(release.resolve);
 const admin=await register(app,'prep-edit@example.com'),pid=await project(app,admin.cookie);
 const headers={cookie:admin.cookie};
 const regenerate=()=>app.inject({method:'POST',url:`/api/projects/${pid}/preparation`,headers});
 const detail=()=>app.inject({url:`/api/projects/${pid}`,headers}).then(r=>r.json());
 const uploaded=await uploadText(app,admin.cookie,pid,'Old project text');
 assert.equal(uploaded.statusCode,200,uploaded.body);
 assert.equal(uploaded.json().preparationWarning,'会前研判未完成，可在项目页重试。');
 const material=uploaded.json().material;
 assert.equal(material.summary,'摘要');
 assert.equal((await detail()).preparation,undefined);
 mode='succeed';
 assert.equal((await regenerate()).statusCode,200);
 mode='wait';
 const generating=regenerate();
 await started.promise;
 try {
  const edited=await app.inject({method:'PATCH',url:`/api/materials/${material.id}`,headers,payload:{summary:'人工更新',pages:[{page:1,text:'Revised project text'}]}});
  assert.equal(edited.statusCode,200,edited.body);
 } finally {release.resolve();}
 assert.equal((await generating).statusCode,409);
 const stale=await detail();
 assert.equal(stale.materials[0].summary,'人工更新');
 assert.equal(stale.preparation,undefined);
 assert.equal(stale.preparationStale,true);
 mode='succeed';
 assert.equal((await regenerate()).statusCode,200);
 assert.equal((await detail()).preparation.overview.product.source.quote,'Revised project text');
 mode='empty';
 assert.equal((await regenerate()).statusCode,424);
 assert.equal((await detail()).preparation.overview.product.source.quote,'Revised project text');
});
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
  createASR(cb){callbacks=cb;cb.onReady?.();started.resolve();return {write(){},close(){},async finish(){finishing.resolve();await release.promise;callbacks.onSegment({id:'tail',text:'last sentence',speaker:'speaker',startMs:1000,endMs:2000,receivedAt:Date.now(),final:true,source:'asr'});}};}};
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

test('editing a material summary preserves long source text and warnings on untouched pages',async t=>{
 const app=await setup(t);
 const a=await register(app,'material-edit@example.com'),pid=await project(app,a.cookie);
 const longText='x'.repeat(30001);
 const uploaded=await uploadText(app,a.cookie,pid,longText+'\f');
 assert.equal(uploaded.statusCode,200,uploaded.body);
 const {material}=uploaded.json();
 assert.ok(material.pages[1].warning);
 const result=await app.inject({method:'PATCH',url:`/api/materials/${material.id}`,headers:{cookie:a.cookie},payload:{summary:'Corrected summary',pages:material.pages}});
 assert.equal(result.statusCode,200,result.body);
 const saved=(await app.inject({url:`/api/projects/${pid}`,headers:{cookie:a.cookie}})).json().materials[0];
 assert.equal(saved.summary,'Corrected summary');
 assert.equal(saved.pages[0].text.length,30001);
 assert.equal(saved.pages[1].warning,material.pages[1].warning);
});

test('saving a correction to a large extracted page keeps the entire page',async t=>{
 const app=await setup(t);
 const a=await register(app,'material-large@example.com'),pid=await project(app,a.cookie);
 const longText='a'.repeat(1100000);
 const uploaded=await uploadText(app,a.cookie,pid,longText);
 assert.equal(uploaded.statusCode,200,uploaded.body.slice(0,200));
 const {material}=uploaded.json();
 const editedText='b'+longText.slice(1);
 const result=await app.inject({method:'PATCH',url:`/api/materials/${material.id}`,headers:{cookie:a.cookie},payload:{pages:[{page:1,text:editedText}]}});
 assert.equal(result.statusCode,200,result.body.slice(0,200));
 assert.equal(result.json().material.pages[0].text,editedText);
});

for(const change of ['summary','page'] as const)test(`background BP analysis preserves manual ${change} changes`,{timeout:8000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vc-material-edit-'));
 const started=deferred(),release=deferred();
 const term={term:'ACE-Step',page:1,quote:'uses ACE-Step'};
 const fake:ProviderAPI={...providers,getCapabilities:()=>({deepseek:true,asr:false,model:'test',version:'test'}),
  summarizeMaterial:async()=>{started.resolve();await release.promise;return 'AI summary';},
  analyzeMaterial:async()=>{started.resolve();await release.promise;return {summary:'AI summary',terms:[term]};}};
 const app=await createApp({dataDir:dir,providers:fake});await app.ready();
 t.after(async()=>{release.resolve();await app.close();await rm(dir,{recursive:true,force:true});});
 const a=await register(app,'material-race@example.com'),pid=await project(app,a.cookie);
 const uploading=uploadText(app,a.cookie,pid,'The project uses ACE-Step');
 await started.promise;
 const material=(await app.inject({url:`/api/projects/${pid}`,headers:{cookie:a.cookie}})).json().materials[0];
 const changed=await app.inject({method:'PATCH',url:`/api/materials/${material.id}`,headers:{cookie:a.cookie},payload:
  change==='page'?{pages:[{page:1,text:'Corrected material'}]}:{summary:'Manual summary'}});
 release.resolve();
 assert.equal(changed.statusCode,200,changed.body);
 const uploaded=await uploading;
 assert.equal(uploaded.statusCode,200,uploaded.body);
 const saved=uploaded.json().material;
 if(change==='summary'){
  assert.equal(saved.summary,'Manual summary');
  assert.deepEqual(saved.terms,[term]);
  const edited=await app.inject({method:'PATCH',url:`/api/materials/${material.id}`,headers:{cookie:a.cookie},payload:{pages:[{page:1,text:'No longer uses that tool'}]}});
  assert.deepEqual(edited.json().material.terms,[]);
 }else{
  assert.equal(saved.pages[0].text,'Corrected material');
  assert.equal(saved.summary,'');
  assert.ok(!saved.terms?.length);
 }
});

test('upload accepts a PPTX over the former 30 MiB limit with embedded media',async t=>{
 const app=await setup(t);
 const a=await register(app,'large-pptx@example.com'),pid=await project(app,a.cookie);
 const archive=zipSync({
  'ppt/presentation.xml':strToU8('<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rA"/></p:sldIdLst></p:presentation>'),
  'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="rA" Target="slides/slide1.xml"/></Relationships>'),
  'ppt/slides/slide1.xml':strToU8('<p:sld><a:t>Extractable slide text</a:t></p:sld>'),
  'ppt/media/image1.jpg':new Uint8Array(18*1024*1024),
  'ppt/media/image2.jpg':new Uint8Array(18*1024*1024),
 },{level:0});
 const result=await uploadFile(app,a.cookie,pid,'slides.pptx',[archive]);
 assert.equal(result.statusCode,200,result.body);
 const {material}=result.json();
 assert.equal(material.pages[0].text,'Extractable slide text');
 const downloaded=await app.inject({url:`/api/materials/${material.id}/file`,headers:{cookie:a.cookie}});
 assert.equal(downloaded.statusCode,200);
 assert.ok(downloaded.rawPayload.equals(Buffer.from(archive.buffer)));
});

test('an older BP can extract verified terms without replacing its manual summary',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vc-material-reanalyze-'));
 let configured=false;
 const term={term:'ACE-Step',page:1,quote:'uses ACE-Step'};
 const fake:ProviderAPI={...providers,getCapabilities:()=>({deepseek:configured,asr:false,model:'test',version:'test'}),
  analyzeMaterial:async()=>({summary:'Unneeded generated summary',terms:[term,{term:'invented',page:99,quote:'invented'}]})};
 const app=await createApp({dataDir:dir,providers:fake});await app.ready();
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const a=await register(app,'material-existing@example.com'),pid=await project(app,a.cookie);
 const material=(await uploadText(app,a.cookie,pid,'The project uses ACE-Step')).json().material;
 assert.equal(material.terms,undefined);
 const url=`/api/materials/${material.id}`;
 const edited=await app.inject({method:'PATCH',url,headers:{cookie:a.cookie},payload:{summary:'Manual summary'}});
 assert.equal(edited.statusCode,200,edited.body);
 configured=true;
 const analyzed=await app.inject({method:'POST',url:`${url}/analysis`,headers:{cookie:a.cookie}});
 assert.equal(analyzed.statusCode,200,analyzed.body);
 assert.equal(analyzed.json().material.summary,'Manual summary');
 assert.deepEqual(analyzed.json().material.terms,[term]);
});

test('upload above 100 MiB shows the file size limit in Chinese',async t=>{
 const app=await setup(t);
 const a=await register(app,'limit-pptx@example.com'),pid=await project(app,a.cookie);
 const chunk=Buffer.alloc(1024*1024);
 const result=await uploadFile(app,a.cookie,pid,'oversized.pptx',Array(101).fill(chunk));
 assert.equal(result.statusCode,413,result.body);
 assert.match(result.json().error,/文件.*100 MiB/);
 assert.deepEqual((await app.inject({url:`/api/projects/${pid}`,headers:{cookie:a.cookie}})).json().materials,[]);
});

for(const change of ['transcript','publication'] as const)test(`AI summary cannot commit after a concurrent ${change} change`,{timeout:8000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vc-summary-conflict-'));
 const generating=deferred(),release=deferred();
 const fake:ProviderAPI={...providers,getCapabilities:()=>({deepseek:true,asr:false,model:'test',version:'test'}),
  summarizeMeeting:async input=>{generating.resolve();await release.promise;return input.segments.map(segment=>segment.text).join('|');}};
 const app=await createApp({dataDir:dir,providers:fake});await app.ready();
 t.after(async()=>{release.resolve();await app.close();await rm(dir,{recursive:true,force:true});});
 const a=await register(app,'summary-conflict@example.com'),pid=await project(app,a.cookie);
 const response=await app.inject({method:'POST',url:`/api/projects/${pid}/meetings`,headers:{cookie:a.cookie},payload:{title:'Real',demo:false}});
 assert.equal(response.statusCode,200,response.body);
 const mid=response.json().meeting.id,summaryUrl=`/api/meetings/${mid}/summary`;
 const db=new Store(join(dir,'vc.sqlite'));
 try{db.finalSegment(mid,{id:'first',text:'Initial transcript',speaker:'Speaker',startMs:0,endMs:1000,receivedAt:1,final:true,source:'manual'});}
 finally{db.close();}
 const original=await app.inject({method:'PATCH',url:summaryUrl,headers:{cookie:a.cookie},payload:{text:'Previously published',published:true}});
 assert.equal(original.statusCode,200,original.body);
 const request=app.inject({method:'POST',url:summaryUrl,headers:{cookie:a.cookie}}).then(r=>r);
 await generating.promise;
 const changed=change==='transcript'
  ? await app.inject({method:'PATCH',url:`/api/meetings/${mid}/segments/first`,headers:{cookie:a.cookie},payload:{text:'Corrected transcript'}})
  : await app.inject({method:'PATCH',url:summaryUrl,headers:{cookie:a.cookie},payload:{text:'Newly published by editor',published:true}});
 release.resolve();
 assert.equal(changed.statusCode,200,changed.body);
 const generated=await request;
 assert.equal(generated.statusCode,409,generated.body);
 assert.match(generated.json().error,/重新生成/);
 const snapshot=await app.inject({url:`/api/meetings/${mid}`,headers:{cookie:a.cookie}});
 assert.equal(snapshot.statusCode,200,snapshot.body);
 assert.deepEqual(snapshot.json().summary,(change==='transcript'?original:changed).json().summary);
});
