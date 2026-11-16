export type Role='admin'|'editor'|'viewer';
export interface User {id:string;name:string;email:string}
export interface Project {id:string;name:string;description:string;createdAt:number;role:Role}
export interface MaterialPage {page:number;text:string;warning?:string}
export interface Material {id:string;projectId:string;name:string;createdAt:number;pages:MaterialPage[];summary:string;status:'ready'|'partial'|'error';warning?:string}
export interface Meeting {id:string;projectId:string;title:string;mode:'online'|'offline';demo:boolean;status:'ready'|'live'|'paused'|'ended';createdAt:number;startedAt?:number;endedAt?:number;ownerId:string;retainAudio:boolean}
export interface Segment {id:string;text:string;speaker:string;startMs:number;endMs:number;final:boolean;receivedAt:number;latencyMs?:number;source:'asr'|'manual'|'demo';gap?:boolean}
export interface Evidence {id:string;title:string;url:string;snippet:string;retrievedAt:number;query:string}
export interface Question {id:string;text:string;reason:string;quote:string;segmentIds:string[];materialPage?:number;status:'new'|'asked'|'answered'|'later'|'dismissed';evidenceIds:string[];createdAt:number;kind:'inference'|'material'|'research';latencyMs?:number}
export interface Comment {id:string;userId:string;userName:string;text:string;private:boolean;createdAt:number}
export interface Summary {text:string;published:boolean;updatedAt:number}
export interface MeetingSnapshot {meeting:Meeting;role:Role;segments:Segment[];questions:Question[];evidence:Evidence[];comments:Comment[];summary:Summary|null;materials:Material[];seq:number}
export interface Capabilities {deepseek:boolean;asr:boolean;model:string;version:string}
export type LiveEvent={type:'snapshot';data:MeetingSnapshot;seq:number}|{type:'transcript.partial';data:Segment}|{type:'status';stage:string;message:string;latencyMs?:number}|{type:'error';message:string}|{type:'audio.ack';seq:number}|{type:'pong'};
export type LiveCommand={type:'start'|'pause'|'resume'|'stop'|'demo.start'|'ping'}|{type:'audio';seq:number;capturedAt:number;pcm:string}|{type:'transcript.manual';text:string;speaker?:string}|{type:'gap';message:string};
