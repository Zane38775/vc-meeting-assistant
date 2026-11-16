import {DatabaseSync} from 'node:sqlite';
import {randomUUID,randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import type {User,Role,Meeting,MeetingSnapshot,Segment,Comment,Summary,Material,Question,Evidence} from '../shared/types';
export const id=()=>randomUUID();
export const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function failure(message:string,statusCode=400):never {throw Object.assign(new Error(message),{statusCode})}
export class Store {
 db:DatabaseSync;
 constructor(path:string){this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE INDEX IF NOT EXISTS records_scope ON records(kind,scope);
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,salt TEXT NOT NULL,password TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,userId TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS counters(id TEXT PRIMARY KEY,n INTEGER NOT NULL);`);}
 put(kind:string,key:string,scope:string,data:unknown){this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET scope=excluded.scope,data=excluded.data').run(kind,key,scope,JSON.stringify(data));}
 get<T>(kind:string,key:string):T|undefined {const r=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,key) as {data:string}|undefined;return r?JSON.parse(r.data):undefined;}
 list<T>(kind:string,scope?:string):T[]{const rows=(scope===undefined?this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind):this.db.prepare('SELECT data FROM records WHERE kind=? AND scope=? ORDER BY rowid').all(kind,scope)) as {data:string}[];return rows.map(r=>JSON.parse(r.data));}
 delete(kind:string,key:string){this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,key);}
 deleteScope(scope:string){this.db.prepare('DELETE FROM records WHERE scope=?').run(scope);}
 next(mid:string){this.db.prepare('INSERT INTO counters VALUES(?,1) ON CONFLICT(id) DO UPDATE SET n=n+1').run(mid);return this.seq(mid);}
 seq(mid:string){return Number((this.db.prepare('SELECT n FROM counters WHERE id=?').get(mid) as any)?.n||0);}
 createUser(email:string,name:string,password:string):User {const salt=randomBytes(16).toString('hex');const user={id:id(),email,name};try{this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user.id,email,name,salt,scryptSync(password,salt,64).toString('hex'));}catch{failure('邮箱已注册',409)}return user;}
 user(uid:string):User|undefined {return this.db.prepare('SELECT id,email,name FROM users WHERE id=?').get(uid) as User|undefined;}
 login(email:string,password:string):User {const r=this.db.prepare('SELECT * FROM users WHERE email=?').get(email) as any;const actual=scryptSync(password,r?.salt||'dummy-login-salt',64);if(!r||!timingSafeEqual(actual,Buffer.from(r.password,'hex')))failure('邮箱或密码不正确',401);return {id:r.id,email:r.email,name:r.name};}
 session(uid:string){const token=randomBytes(32).toString('base64url');this.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),uid,Date.now()+7*86400000);return token;}
 fromSession(token?:string):User|undefined {if(!token)return;const r=this.db.prepare('SELECT userId FROM sessions WHERE token=? AND expires>?').get(hash(token),Date.now()) as any;return r?this.user(r.userId):undefined;}
 logout(token?:string){if(token)this.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));}
 role(pid:string,uid:string):Role|undefined{return this.get<{role:Role}>('member',`${pid}:${uid}`)?.role;}
 requireRole(pid:string,uid:string,edit=false){const role=this.role(pid,uid);if(!role||edit&&role==='viewer')failure('没有访问权限',403);return role;}
 meeting(mid:string,uid:string,edit=false){const m=this.get<Meeting>('meeting',mid);if(!m)failure('会议不存在',404);this.requireRole(m.projectId,uid,edit);return m;}
 snapshot(mid:string,uid:string):MeetingSnapshot {const meeting=this.meeting(mid,uid);const role=this.requireRole(meeting.projectId,uid);const summary=this.get<Summary>('summary',mid);return {meeting,role,segments:this.list<Segment>('segment',mid).sort((a,b)=>a.startMs-b.startMs),questions:this.list<Question>('question',mid),evidence:this.list<Evidence>('evidence',mid),comments:this.list<Comment>('comment',mid).filter(c=>!c.private||c.userId===uid),summary:summary&&(summary.published||role!=='viewer')?summary:null,materials:this.list<Material>('material',meeting.projectId),seq:this.seq(mid)};}
 finalSegment(mid:string,segment:Segment){const key=`${mid}:${segment.id}`;const old=this.get<Segment>('segment',key);if(old&&old.text===segment.text&&old.speaker===segment.speaker)return false;this.put('segment',key,mid,{...segment,final:true});return true;}
 close(){this.db.close();}
}
