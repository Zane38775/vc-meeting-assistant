import type {Capabilities,MaterialPage,Segment,Question,Evidence,Material} from '../../shared/types';
export interface AnalysisInput {segments:Segment[];questions:Question[];materials:Material[];projectName:string}
export interface QuestionDraft {text:string;reason:string;quote:string;segmentIds:string[];materialPage?:number;researchQuery?:string}
export interface ASRCallbacks {onSegment:(segment:Segment)=>void;onStatus:(message:string)=>void;onError:(error:Error)=>void}
export interface ASRSession {write(pcm:Buffer):void;finish():Promise<void>;close():void}
export interface ProviderAPI {
 getCapabilities():Capabilities;
 analyzeContext(input:AnalysisInput,signal?:AbortSignal):Promise<{questions:QuestionDraft[]}>;
 researchTopic(query:string,signal?:AbortSignal):Promise<Evidence[]>;
 summarizeMeeting(input:AnalysisInput,signal?:AbortSignal):Promise<string>;
 summarizeMaterial(pages:MaterialPage[],signal?:AbortSignal):Promise<string>;
 createASR(callbacks:ASRCallbacks):ASRSession;
}
