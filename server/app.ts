import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {mkdir,writeFile,unlink,readFile,rename,chmod} from 'node:fs/promises';
import {existsSync,createReadStream} from 'node:fs';
import {resolve,join,extname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store,id,hash,failure} from './store';
import {LiveHub} from './live';
import type {ProviderAPI} from './providers/contracts';
import type {User,Project,Meeting,Material,Question,Comment,Segment,Summary,Role} from '../shared/types';
export interface AppOptions {dbPath?:string;dataDir?:string;providers?:ProviderAPI;clientDir?:string;configPath?:string}
const text=(v:unknown,max=5000)=>typeof v==='string'?v.trim().slice(0,max):'';
export async function createApp(options:AppOptions={}) {
 const dataDir=resolve(options.dataDir||process.env.DATA_DIR||'data');await mkdir(join(dataDir,'files'),{recursive:true});
 const store=new Store(options.dbPath||join(dataDir,'vc.sqlite'));
 const providers=options.providers||(await import('./providers/index'));
 const hub=new LiveHub(store,providers,dataDir);
 const app=Fastify({logger:false,bodyLimit:1024*1024});
 await app.register(cookie);await app.register(multipart,{limits:{fileSize:30*1024*1024,files:1,fields:4}});await app.register(websocket,{options:{maxPayload:100000}});
 const logged=(req:any):User=>{const u=store.fromSession(req.cookies.vc_session);if(!u)failure('请先登录',401);return u};
 const body=(req:any)=>req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:{};
 const allowOrigin=(req:any)=>{const origin=req.headers.origin;if(!origin)return true;return [process.env.PUBLIC_ORIGIN,`http://${req.headers.host}`,`https://${req.headers.host}`,'http://127.0.0.1:5173','http://localhost:5173'].filter(Boolean).includes(origin)};
 app.addHook('onRequest',async(req,reply)=>{reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin');if(req.url.startsWith('/api/')){reply.header('Cache-Control','no-store');if((!['GET','HEAD','OPTIONS'].includes(req.method)||req.headers.upgrade)&&!allowOrigin(req))failure('请求来源不受信任',403)}});
 app.setErrorHandler((error:any,_req,reply)=>{const code=Number(error.statusCode||500);reply.code(code>=400&&code<600?code:500).send({error:code<500?error.message:'服务器处理失败，请检查服务状态'});});
 app.addHook('onClose',async()=>{hub.close();store.close()});
 const authAttempts=new Map<string,{n:number;at:number}>();
 const throttle=(req:any)=>{const key=req.ip;const now=Date.now();for(const[k,v]of authAttempts)if(now-v.at>60000)authAttempts.delete(k);const value=authAttempts.get(key)||{n:0,at:now};if(++value.n>20)failure('登录尝试过多，请一分钟后重试',429);authAttempts.set(key,value)};
 const setSession=(reply:any,u:User)=>{const token=store.session(u.id);reply.setCookie('vc_session',token,{path:'/',httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',maxAge:7*86400});return {user:u}};
 app.get('/api/health',async()=>providers.getCapabilities());
 app.get('/api/session',async req=>({user:store.fromSession(req.cookies.vc_session)||null}));
 const settings=(req:any,u:User)=>({canManageSettings:['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip)&&store.get<any>('meta','operator')?.userId===u.id,deepseekConfigured:Boolean(process.env.DEEPSEEK_API_KEY?.trim()),asrProvider:process.env.ASR_PROVIDER==='tencent'?'tencent':'local',modelReady:providers.getCapabilities().asr});
 app.get('/api/settings',async req=>settings(req,logged(req)));
 app.post('/api/settings',async req=>{const u=logged(req);if(!settings(req,u).canManageSettings)failure('仅本机服务管理员可以配置密钥',403);const key=text(body(req).deepseekApiKey,500);if(key.length<10||/[\r\n\s"'\\]/.test(key))failure('请输入有效的 DeepSeek API 密钥');const path=resolve(options.configPath||(options.dbPath===':memory:'?join(dataDir,'.env'):process.env.DOTENV_CONFIG_PATH||'.env'));let current=await readFile(path,'utf8').catch(()=>'');current=current.replace(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=.*\r?\n?/gm,'');const temp=`${path}.${id()}.tmp`;await writeFile(temp,`${current.trimEnd()}\nDEEPSEEK_API_KEY=${key}\n`,{mode:0o600});await rename(temp,path);await chmod(path,0o600).catch(()=>{});process.env.DEEPSEEK_API_KEY=key;return settings(req,u)});
 app.post('/api/auth/register',async(req,reply)=>{throttle(req);const b=body(req);const email=text(b.email,200).toLowerCase(),name=text(b.name,60),password=text(b.password,200);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name||password.length<10)failure('请输入姓名、有效邮箱和至少 10 位密码');const user=store.createUser(email,name,password);if(!store.get('meta','operator'))store.put('meta','operator','system',{userId:user.id});return setSession(reply,user)});
 app.post('/api/auth/login',async(req,reply)=>{throttle(req);const b=body(req);return setSession(reply,store.login(text(b.email,200).toLowerCase(),text(b.password,200)))});
 app.post('/api/auth/logout',async(req,reply)=>{const u=store.fromSession(req.cookies.vc_session);store.logout(req.cookies.vc_session);if(u)for(const p of hub.peers)if(p.user.id===u.id)p.socket.close(4001,'已退出登录');reply.clearCookie('vc_session',{path:'/'});return {ok:true}});
 app.get('/api/projects',async req=>{const u=logged(req);return {projects:store.list<Project>('project').filter(p=>store.role(p.id,u.id)).map(p=>({...p,role:store.role(p.id,u.id)}))}});
 app.post('/api/projects',async req=>{const u=logged(req),b=body(req);if(!text(b.name,100))failure('请输入项目名称');const project:Project={id:id(),name:text(b.name,100),description:text(b.description,1000),createdAt:Date.now(),role:'admin'};store.put('project',project.id,project.id,project);store.put('member',`${project.id}:${u.id}`,project.id,{userId:u.id,role:'admin'});return {project}});
 app.get('/api/projects/:pid',async(req:any)=>{const u=logged(req),pid=req.params.pid;const role=store.requireRole(pid,u.id);const project=store.get<Project>('project',pid);if(!project)failure('项目不存在',404);const members=store.list<any>('member',pid).map(m=>({...store.user(m.userId),role:m.role}));return {project:{...project,role},materials:store.list('material',pid),meetings:store.list('meeting',pid),members}});
 app.delete('/api/projects/:pid',async(req:any)=>{
  const u=logged(req),pid=req.params.pid;if(store.requireRole(pid,u.id)!=='admin')failure('仅管理员可以删除项目',403);
  const meetings=store.list<Meeting>('meeting',pid),materials=store.list<Material>('material',pid);
  hub.revoke(pid);
  // Revoke every write before filesystem awaits; in-flight uploads recheck below.
  for(const m of meetings){hub.dispose(m.id);store.deleteScope(m.id);}
  store.deleteScope(pid);
  for(const m of meetings)await unlink(join(dataDir,'audio',`${m.id}.pcm`)).catch(()=>{});
  for(const m of materials)await unlink(join(dataDir,'files',m.id)).catch(()=>{});
  return {ok:true};
 });
 app.post('/api/projects/:pid/invites',async(req:any)=>{const u=logged(req),pid=req.params.pid;if(store.requireRole(pid,u.id)!=='admin')failure('仅管理员可以邀请成员',403);const b=body(req);const role:Role=b.role==='editor'?'editor':'viewer';const token=randomBytes(24).toString('base64url'),expiresAt=Date.now()+86400000;store.put('invite',hash(token),pid,{projectId:pid,role,expiresAt});return {token,expiresAt}});
 app.post('/api/invites/accept',async req=>{const u=logged(req),token=text(body(req).token,200),key=hash(token);const inv=store.get<any>('invite',key);if(!inv||inv.expiresAt<Date.now())failure('邀请已失效或已使用');if(!store.get('project',inv.projectId))failure('项目不存在',404);if(!store.role(inv.projectId,u.id))store.put('member',`${inv.projectId}:${u.id}`,inv.projectId,{userId:u.id,role:inv.role});store.delete('invite',key);return {projectId:inv.projectId}});
 app.delete('/api/projects/:pid/members/:uid',async(req:any)=>{const u=logged(req),{pid,uid}=req.params;if(store.requireRole(pid,u.id)!=='admin'||uid===u.id)failure('不能移除该成员',403);store.delete('member',`${pid}:${uid}`);hub.revoke(pid,uid);return {ok:true}});
 app.post('/api/projects/:pid/materials',async(req:any)=>{
  const u=logged(req),pid=req.params.pid;store.requireRole(pid,u.id,true);
  const file=await req.file();if(!file)failure('请选择文件');
  const buffer=await file.toBuffer();if(file.file.truncated)failure('文件超过 30 MiB 限制',413);
  const {parseMaterial}=await import('./materials');
  const parsed=await parseMaterial(buffer,file.filename).catch(e=>failure(e instanceof Error?e.message:'材料解析失败'));
  store.requireRole(pid,u.id,true);
  const material:Material={id:id(),projectId:pid,name:text(file.filename,200),createdAt:Date.now(),pages:parsed.pages,summary:'',status:parsed.warning?'partial':'ready',warning:parsed.warning};
  const filePath=join(dataDir,'files',material.id);
  await writeFile(filePath,buffer,{flag:'wx'});
  try{
   if(!store.get('project',pid))failure('材料或项目已删除',404);
   store.requireRole(pid,u.id,true);
   store.put('material',material.id,pid,material);
  }catch(error){await unlink(filePath).catch(()=>{});throw error;}
  if(providers.getCapabilities().deepseek){
   try{material.summary=await providers.summarizeMaterial(material.pages,AbortSignal.timeout(30000));}
   catch{material.warning=[material.warning,'AI 摘要未完成，可稍后重试或手动编辑'].filter(Boolean).join('；');material.status='partial';}
   if(!store.get('material',material.id))failure('材料或项目已删除',404);
   store.requireRole(pid,u.id,true);store.put('material',material.id,pid,material);
  }
  return {material};
 });
 app.patch('/api/materials/:id',async(req:any)=>{const u=logged(req),m=store.get<Material>('material',req.params.id);if(!m)failure('材料不存在',404);store.requireRole(m.projectId,u.id,true);const b=body(req);if(typeof b.summary==='string')m.summary=text(b.summary,30000);if(Array.isArray(b.pages)){for(const page of b.pages){const found=m.pages.find(p=>p.page===page.page);if(found&&typeof page.text==='string'){found.text=text(page.text,30000);found.warning=undefined}}}store.put('material',m.id,m.projectId,m);return {material:m}});
 app.get('/api/materials/:id/file',async(req:any,reply)=>{const u=logged(req),m=store.get<Material>('material',req.params.id);if(!m)failure('材料不存在',404);store.requireRole(m.projectId,u.id);const ext=extname(m.name).toLowerCase();reply.type(ext==='.pdf'?'application/pdf':'application/octet-stream');reply.header('Content-Disposition',`${ext==='.pdf'?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(m.name)}`);return reply.send(createReadStream(join(dataDir,'files',m.id)))});
 app.post('/api/projects/:pid/meetings',async(req:any)=>{const u=logged(req),pid=req.params.pid;store.requireRole(pid,u.id,true);const b=body(req);const meeting:Meeting={id:id(),projectId:pid,title:text(b.title,120)||'项目访谈',mode:b.mode==='online'?'online':'offline',demo:b.demo===true,retainAudio:b.retainAudio===true,status:'ready',createdAt:Date.now(),ownerId:u.id};store.put('meeting',meeting.id,pid,meeting);return {meeting}});
 app.get('/api/meetings/:mid',async(req:any)=>store.snapshot(req.params.mid,logged(req).id));
 app.get('/api/meetings/:mid/live',{websocket:true,preValidation:async(req:any)=>{const u=logged(req);store.meeting(req.params.mid,u.id)}},(socket,req:any)=>{hub.attach(socket,logged(req),req.params.mid)});
 app.patch('/api/meetings/:mid/questions/:qid',async(req:any)=>{const u=logged(req),{mid,qid}=req.params;store.meeting(mid,u.id,true);const q=store.get<Question>('question',`${mid}:${qid}`);if(!q)failure('问题不存在',404);const status=body(req).status;if(!['new','asked','answered','later','dismissed'].includes(status))failure('无效问题状态');q.status=status;store.put('question',`${mid}:${qid}`,mid,q);hub.broadcast(mid);return {question:q}});
 app.post('/api/meetings/:mid/questions',async(req:any)=>{const u=logged(req),mid=req.params.mid;store.meeting(mid,u.id,true);const value=text(body(req).text,1000);if(!value)failure('请输入问题');const q:Question={id:id(),text:value,reason:'用户补充',quote:'',segmentIds:[],evidenceIds:[],status:'new',createdAt:Date.now(),kind:'inference'};store.put('question',`${mid}:${q.id}`,mid,q);hub.broadcast(mid);return {question:q}});
 app.patch('/api/meetings/:mid/segments/:sid',async(req:any)=>{const u=logged(req),{mid,sid}=req.params;store.meeting(mid,u.id,true);const s=store.get<Segment>('segment',`${mid}:${sid}`);if(!s)failure('转写不存在',404);const b=body(req);if(typeof b.text==='string')s.text=text(b.text,6000);if(typeof b.speaker==='string')s.speaker=text(b.speaker,60);store.put('segment',`${mid}:${sid}`,mid,s);hub.broadcast(mid);return {segment:s}});
 app.post('/api/meetings/:mid/comments',async(req:any)=>{const u=logged(req),mid=req.params.mid;store.meeting(mid,u.id);const b=body(req),value=text(b.text,4000);if(!value)failure('请输入内容');const comment:Comment={id:id(),userId:u.id,userName:u.name,text:value,private:b.private===true,createdAt:Date.now()};store.put('comment',`${mid}:${comment.id}`,mid,comment);hub.broadcast(mid);return {comment}});
 app.patch('/api/meetings/:mid/comments/:cid',async(req:any)=>{const u=logged(req),{mid,cid}=req.params;store.meeting(mid,u.id);const c=store.get<Comment>('comment',`${mid}:${cid}`);if(!c||c.userId!==u.id)failure('只能修改自己的笔记',403);c.private=body(req).private===true;store.put('comment',`${mid}:${cid}`,mid,c);hub.broadcast(mid);return {comment:c}});
 app.post('/api/meetings/:mid/summary',async(req:any)=>{const u=logged(req),mid=req.params.mid,m=store.meeting(mid,u.id,true);if(m.status==='live')failure('请先结束或暂停录音，再生成纪要');if(hub.runtimes.get(mid)?.transition)failure('正在完成最后一段语音，请等待转写完成后生成纪要',409);let result:string;if(m.demo){result=`# ${m.title}\n\n> 演示纪要：根据预设演示文字整理，未经真实模型分析。\n\n## 对话记录\n\n`+store.list<Segment>('segment',mid).map(s=>`- [${Math.floor(s.startMs/1000)} 秒] ${s.speaker}：${s.text}`).join('\n')}else{if(!providers.getCapabilities().deepseek)failure('尚未配置 DeepSeek API');result=await providers.summarizeMeeting(hub.input(mid),AbortSignal.timeout(120000))}store.meeting(mid,u.id,true);const summary:Summary={text:result,published:false,updatedAt:Date.now()};store.put('summary',mid,mid,summary);hub.broadcast(mid);return {summary}});
 app.patch('/api/meetings/:mid/summary',async(req:any)=>{const u=logged(req),mid=req.params.mid;store.meeting(mid,u.id,true);const previous=store.get<Summary>('summary',mid),b=body(req);const summary:Summary={text:typeof b.text==='string'?text(b.text,60000):previous?.text||'',published:typeof b.published==='boolean'?b.published:previous?.published||false,updatedAt:Date.now()};store.put('summary',mid,mid,summary);hub.broadcast(mid);return {summary}});
 app.get('/api/meetings/:mid/export',async(req:any,reply)=>{const s=store.snapshot(req.params.mid,logged(req).id);const md=`# ${s.meeting.title}\n\n${s.meeting.demo?'> 演示会议，内容不是实际会议记录。\n\n':''}${s.summary?.text||'尚未发布纪要。'}\n\n## 转写记录\n\n${s.segments.map(x=>`- [${Math.floor(x.startMs/1000)} 秒] ${x.speaker}（${x.source}）：${x.text}`).join('\n')}\n\n## 待问问题\n\n${s.questions.map(q=>`- [${q.status}] ${q.text}\n  原因：${q.reason}\n  触发原话：${q.quote}`).join('\n')}\n\n## 外部资料\n\n${s.evidence.map(e=>`- [${e.title}](${e.url})`).join('\n')}`;reply.type('text/markdown; charset=utf-8').header('Content-Disposition',`attachment; filename="meeting-${s.meeting.id}.md"`);return md});
 const clientDir=resolve(options.clientDir||process.env.CLIENT_DIR||'dist/client');if(existsSync(join(clientDir,'index.html'))){await app.register(fastifyStatic,{root:clientDir,prefix:'/'});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'))}
 return app;
}
