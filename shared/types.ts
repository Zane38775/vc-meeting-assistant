export type Role='admin'|'editor'|'viewer';
export interface User {id:string;name:string;email:string}
export interface Project {id:string;name:string;description:string;createdAt:number;role:Role}
export interface MaterialPage {page:number;text:string;warning?:string}
export interface MaterialTerm {term:string;page:number;quote:string}
export interface Material {id:string;projectId:string;name:string;createdAt:number;pages:MaterialPage[];summary:string;terms?:MaterialTerm[];status:'ready'|'partial'|'error';warning?:string}
export const PREPARATION_OVERVIEW=['company','product','customers','problem','technicalApproach','businessModel','keyMetrics','financing'] as const;
export const PREPARATION_HYPOTHESES=['businessModel','growth','unitEconomics','moat'] as const;
export interface PreparationSource {materialId:string;page:number;quote:string}
export interface PreparationClaim {statement:string;source:PreparationSource}
export interface PreparationHypothesis {assumption:string;gap:string;source:PreparationSource}
export interface PreparationQuestion {text:string;why:string;evidenceWanted:string;source:PreparationSource}
export interface PreparationDraft {
 overview:Partial<Record<typeof PREPARATION_OVERVIEW[number],PreparationClaim>>;
 hypotheses:Partial<Record<typeof PREPARATION_HYPOTHESES[number],PreparationHypothesis>>;
 questions:PreparationQuestion[];
}
export interface ProjectPreparation extends PreparationDraft {
 generatedAt:number;
 inspectedPages:number;
 totalPages:number;
 excerpted:boolean;
}
export interface Meeting {id:string;projectId:string;title:string;mode:'online'|'offline';demo:boolean;status:'ready'|'live'|'paused'|'ended';createdAt:number;startedAt?:number;endedAt?:number;ownerId:string;retainAudio:boolean;finishingCapture?:true}
export interface Segment {id:string;text:string;speaker:string;startMs:number;endMs:number;final:boolean;receivedAt:number;latencyMs?:number;source:'asr'|'manual'|'demo';gap?:boolean}
export interface Evidence {id:string;title:string;url:string;snippet:string;retrievedAt:number;query:string}
export interface ResearchFinding {sourceId:string;quote:string;point:string;relevance:string;uncertainty:string}
export interface ResearchBrief {query:string;updatedAt:number;status:'ready'|'unavailable';findings:ResearchFinding[]}
export const QUESTION_FOCUSES=['customer_evidence','commercial_model','unit_economics','technical_moat','risk','next_validation','clarification'] as const;
export type QuestionFocus=typeof QUESTION_FOCUSES[number];
export interface Question {id:string;text:string;reason:string;quote:string;segmentIds:string[];materialId?:string;materialPage?:number;focus?:QuestionFocus;status:'new'|'asked'|'answered'|'later'|'dismissed';evidenceIds:string[];createdAt:number;kind:'inference'|'material'|'research';latencyMs?:number}
export interface Comment {id:string;userId:string;userName:string;text:string;private:boolean;createdAt:number}
export interface Summary {text:string;published:boolean;updatedAt:number}
export interface MeetingSnapshot {meeting:Meeting;role:Role;segments:Segment[];questions:Question[];evidence:Evidence[];researchBriefs?:ResearchBrief[];comments:Comment[];summary:Summary|null;materials:Material[];seq:number}
export interface Capabilities {deepseek:boolean;asr:boolean;model:string;version:string}
export type LiveEvent={type:'snapshot';data:MeetingSnapshot;seq:number}|{type:'transcript.partial';data:Segment}|{type:'status';stage:string;message:string;latencyMs?:number}|{type:'error';message:string;command?:string;requestId?:string}|{type:'capture.ready';meetingId:string;requestId:string}|{type:'audio.ack';seq:number}|{type:'pong'};
export type LiveCommand={type:'start'|'resume';requestId?:string}|{type:'pause'|'stop'|'demo.start'|'ping'}|{type:'audio';seq:number;capturedAt:number;pcm:string}|{type:'transcript.manual';text:string;speaker?:string}|{type:'gap';message:string};
