import type {Capabilities} from '../../shared/types';
import {createTencentASR,tencentConfig} from './tencent';
import {createLocalASR,localASRAvailable} from './local';
import type {ASRCallbacks,ASRSession} from './contracts';
export {analyzeContext,researchTopic,summarizeResearch,summarizeMeeting,summarizeMaterial,analyzeMaterial,prepareProject} from './deepseek';
export type {ProviderAPI,AnalysisInput,QuestionDraft,ASRCallbacks,ASRSession} from './contracts';
export function createASR(callbacks:ASRCallbacks,options:{hotwords?:readonly string[]}={}):ASRSession {if(process.env.ASR_PROVIDER==='tencent')return createTencentASR(callbacks);if(process.env.ASR_PROVIDER&&process.env.ASR_PROVIDER!=='local')throw new Error('不支持该语音识别来源，请使用 local');return createLocalASR(callbacks,options);}
export function getCapabilities():Capabilities {const c=tencentConfig();const provider=process.env.ASR_PROVIDER||'local';return {deepseek:Boolean(process.env.DEEPSEEK_API_KEY?.trim()),asr:provider==='tencent'?Boolean(c.appId&&c.secretId&&c.secretKey):provider==='local'&&localASRAvailable(),model:process.env.DEEPSEEK_MODEL||'deepseek-flash',version:'0.1.2-beta.2'};}
