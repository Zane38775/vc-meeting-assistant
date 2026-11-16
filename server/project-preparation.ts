import {PREPARATION_HYPOTHESES,PREPARATION_OVERVIEW} from '../shared/types';
import type {Material,PreparationDraft,PreparationSource,ProjectPreparation} from '../shared/types';
import type {ProjectPreparationInput} from './providers/contracts';
import {hash,type Store} from './store';

const INPUT_CHAR_LIMIT=48_000;
const INPUT_PAGE_LIMIT=120;
const PAGE_CHAR_LIMIT=1_500;
const FIELD_CHAR_LIMIT=100;
const QUOTE_CHAR_LIMIT=140;

export interface StoredPreparation {
 revision:string;
 sourceDigest:string;
 preparation:ProjectPreparation;
}

export function preparationSourceDigest(materials:Material[]):string {
 return hash(JSON.stringify(materials.map(({id,name,pages})=>[id,name,pages])));
}

export function currentPreparation(store:Store,projectId:string,materials:Material[]){
 const record=store.get<StoredPreparation>('projectPreparation',projectId);
 if(!record)return {};
 if(record.sourceDigest!==preparationSourceDigest(materials))return {preparationStale:true};
 return {preparation:record.preparation};
}

export function projectPreparationInput(projectName:string,materials:Material[]):ProjectPreparationInput {
 const totalPages=materials.reduce((count,material)=>count+material.pages.length,0);
 const sources=materials.map(({id,name,pages})=>({id,name,pages:pages.filter(page=>page.text.trim())}));
 const excerpts=new Map<string,ProjectPreparationInput['materials'][number]>();
 let remaining=INPUT_CHAR_LIMIT,inspectedPages=0,excerpted=false;
 // Take pages in rounds across the project's files so one long deck cannot consume the entire budget.
 const maxDepth=sources.reduce((maximum,source)=>Math.max(maximum,source.pages.length),0);
 for(let index=0;index<maxDepth&&remaining&&inspectedPages<INPUT_PAGE_LIMIT;index++){
  for(const source of sources){
   const page=source.pages[index];
   if(!page)continue;
   const text=page.text.slice(0,Math.min(PAGE_CHAR_LIMIT,remaining));
   const existing=excerpts.get(source.id)??{id:source.id,name:source.name,pages:[]};
   existing.pages.push({page:page.page,text});
   excerpts.set(source.id,existing);
   remaining-=text.length;
   inspectedPages++;
   excerpted ||= text.length!==page.text.length;
   if(!remaining||inspectedPages===INPUT_PAGE_LIMIT)break;
  }
 }
 return {projectName,materials:[...excerpts.values()],totalPages,excerpted:excerpted||inspectedPages!==totalPages};
}

function record(value:unknown):Record<string,unknown>|undefined {
 if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>;
}

function boundedText(value:unknown,max:number):string|undefined {
 if(typeof value==='string'&&value.length<=max)return value.trim()||undefined;
}

export function hasPreparationItems(draft:PreparationDraft):boolean {
 return Object.keys(draft.overview).length>0||Object.keys(draft.hypotheses).length>0||draft.questions.length>0;
}

export function validatePreparation(data:unknown,input:ProjectPreparationInput):PreparationDraft {
 const payload=record(data);
 const overview=record(payload?.overview),hypotheses=record(payload?.hypotheses);
 if(!overview||!hypotheses||!Array.isArray(payload?.questions))throw new Error('AI 会前研判格式错误');
 const sources=new Map(input.materials.map(material=>[material.id,material]));
 const result:PreparationDraft={overview:{},hypotheses:{},questions:[]};
 const citation=(value:unknown):PreparationSource|undefined=>{
  const source=record(value);
  const materialId=source?.materialId,page=source?.page,quote=source?.quote;
  if(typeof materialId!=='string'||typeof page!=='number'||!Number.isInteger(page)||typeof quote!=='string'||!boundedText(quote,QUOTE_CHAR_LIMIT))return;
  if(!/\p{L}.*\p{L}/su.test(quote))return;
  if(!sources.get(materialId)?.pages.some(item=>item.page===page&&item.text.includes(quote)))return;
  return {materialId,page,quote};
 };
 for(const key of PREPARATION_OVERVIEW){
  const item=record(overview[key]);
  const statement=boundedText(item?.statement,FIELD_CHAR_LIMIT),source=citation(item?.source);
  if(statement&&source){
   const quoteNumbers=new Set(source.quote.normalize('NFKC').match(/\d+(?:[.,]\d+)*/g)??[]);
   const statementNumbers=statement.normalize('NFKC').match(/\d+(?:[.,]\d+)*/g)??[];
   if(statementNumbers.every(number=>quoteNumbers.has(number)))result.overview[key]={statement,source};
  }
 }
 for(const key of PREPARATION_HYPOTHESES){
  const item=record(hypotheses[key]);
  const assumption=boundedText(item?.assumption,FIELD_CHAR_LIMIT),gap=boundedText(item?.gap,FIELD_CHAR_LIMIT),source=citation(item?.source);
  if(assumption&&gap&&source)result.hypotheses[key]={assumption,gap,source};
 }
 const priorQuestions=new Set<string>();
 for(const value of payload.questions.slice(0,20)){
  const item=record(value);
  const text=boundedText(item?.text,FIELD_CHAR_LIMIT),why=boundedText(item?.why,FIELD_CHAR_LIMIT),evidenceWanted=boundedText(item?.evidenceWanted,FIELD_CHAR_LIMIT),source=citation(item?.source);
  if(!text||!why||!evidenceWanted||!source)continue;
  const key=text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
  if(!key||priorQuestions.has(key))continue;
  priorQuestions.add(key);
  result.questions.push({text,why,evidenceWanted,source});
  if(result.questions.length===5)break;
 }
 const hasCandidates=PREPARATION_OVERVIEW.some(key=>overview[key]!=null)||
  PREPARATION_HYPOTHESES.some(key=>hypotheses[key]!=null)||payload.questions.length>0;
 if(hasCandidates&&!hasPreparationItems(result))throw new Error('AI 会前研判引用无法核实');
 return result;
}
