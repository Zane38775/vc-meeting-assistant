import type {Capabilities,MaterialPage,MaterialTerm,Segment,Question,QuestionFocus,Evidence,Material,ResearchFinding,ResearchBrief,PreparationDraft,ProjectPreparation} from '../../shared/types';
export interface AnalysisInput {segments:Segment[];questions:Question[];materials:Material[];projectName:string;newSegmentIds?:string[];researchBriefs?:ResearchBrief[];evidence?:Evidence[];preparation?:ProjectPreparation}
export interface ProjectPreparationInput {projectName:string;materials:Pick<Material,'id'|'name'|'pages'>[];totalPages:number;excerpted:boolean}
export interface QuestionDraft {text:string;reason:string;quote:string;segmentIds:string[];materialId?:string;materialPage?:number;focus?:QuestionFocus;researchQuery?:string}
export interface ASRCallbacks {onReady?:()=>void;onSegment:(segment:Segment)=>void;onStatus:(message:string)=>void;onError:(error:Error)=>void}
export interface ASRSession {write(pcm:Buffer):void;finish():Promise<void>;close():void}
export interface ProviderAPI {
 getCapabilities():Capabilities;
 analyzeContext(input:AnalysisInput,signal?:AbortSignal):Promise<{questions:QuestionDraft[]}>;
 researchTopic(query:string,signal?:AbortSignal):Promise<Evidence[]>;
 summarizeResearch?(query:string,evidence:Evidence[],signal?:AbortSignal):Promise<ResearchFinding[]>;
 summarizeMeeting(input:AnalysisInput,signal?:AbortSignal):Promise<string>;
 summarizeMaterial(pages:MaterialPage[],signal?:AbortSignal):Promise<string>;
 analyzeMaterial?(pages:MaterialPage[],signal?:AbortSignal):Promise<{summary:string;terms:MaterialTerm[]}>;
 prepareProject?(input:ProjectPreparationInput,signal?:AbortSignal):Promise<PreparationDraft>;
 createASR(callbacks:ASRCallbacks,options?:{hotwords?:readonly string[]}):ASRSession;
}
