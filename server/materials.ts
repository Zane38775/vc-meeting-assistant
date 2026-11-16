import {extname,posix} from 'node:path';
import {unzipSync} from 'fflate';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import type {MaterialPage} from '../shared/types';
import {MATERIAL_FILE_LIMIT_MESSAGE,MAX_MATERIAL_FILE_BYTES} from '../shared/material-limits';

const MAX_PAGES=100;
export const MAX_MATERIAL_TEXT=2*1024*1024;
const EMPTY='该页没有可提取文字，可能为图像或扫描页；尚未进行 OCR，请核对原文件并补充文字。';
const xmlParser=new XMLParser({ignoreAttributes:false,transformTagName:name=>name.split(':').at(-1)!,parseTagValue:false,trimValues:false,processEntities:true});
function xml(bytes:Uint8Array){const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)throw new Error('PPTX XML 格式错误或包含不支持的实体');return xmlParser.parse(text);}
const array=(v:any):any[]=>v==null?[]:Array.isArray(v)?v:[v];
function texts(node:any):string[]{if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(texts);return Object.entries(node).flatMap(([key,value])=>key==='t'?array(value).map(v=>typeof v==='string'?v:typeof v==='object'?String(v['#text']??''):''):texts(value));}

/** Validate central directory BEFORE allocating decompressed entries. ZIP64/encryption are not accepted. */
function pptxFiles(buffer:Buffer):Record<string,Uint8Array>{
 let eocd=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50&&i+22+buffer.readUInt16LE(i+20)===buffer.length){eocd=i;break;}
 if(eocd<0)throw new Error('PPTX 压缩结构无效');
 const count=buffer.readUInt16LE(eocd+10),centralSize=buffer.readUInt32LE(eocd+12),centralStart=buffer.readUInt32LE(eocd+16);
 if(buffer.readUInt16LE(eocd+4)||buffer.readUInt16LE(eocd+6)||count===65535||count>5000||centralStart+centralSize!==eocd)throw new Error('PPTX 压缩结构或文件数量超限');
 let at=centralStart,total=0,xmlTotal=0;const names=new Set<string>();
 for(let i=0;i<count;i++){
  if(at+46>eocd||buffer.readUInt32LE(at)!==0x02014b50)throw new Error('PPTX 压缩目录损坏');
  const flags=buffer.readUInt16LE(at+8),method=buffer.readUInt16LE(at+10),compressed=buffer.readUInt32LE(at+20),size=buffer.readUInt32LE(at+24),nameLength=buffer.readUInt16LE(at+28),extra=buffer.readUInt16LE(at+30),comment=buffer.readUInt16LE(at+32),local=buffer.readUInt32LE(at+42);
  const end=at+46+nameLength+extra+comment;if(end>eocd||local+30>centralStart||buffer.readUInt32LE(local)!==0x04034b50)throw new Error('PPTX 压缩目录损坏');
  const name=buffer.subarray(at+46,at+46+nameLength).toString('utf8');
  if(flags&1||![0,8].includes(method)||name.includes('\\')||name.startsWith('/')||name.split('/').includes('..')||names.has(name)||size===0xffffffff||compressed===0xffffffff)throw new Error('PPTX 压缩格式不支持');
  names.add(name);total+=size;if(name.endsWith('.xml')||name.endsWith('.rels'))xmlTotal+=size;
  if(size>32*1024*1024||total>128*1024*1024||xmlTotal>16*1024*1024||(size>1024*1024&&size>Math.max(compressed,1)*200))throw new Error('PPTX 解压膨胀超过安全限制');
  const localNameLength=buffer.readUInt16LE(local+26),localExtra=buffer.readUInt16LE(local+28);
  if(local+30+localNameLength+localExtra+compressed>centralStart||buffer.readUInt16LE(local+8)!==method||buffer.subarray(local+30,local+30+localNameLength).toString('utf8')!==name)throw new Error('PPTX 压缩目录与内容不匹配');
  at=end;
 }
 if(at!==eocd)throw new Error('PPTX 压缩目录长度无效');
 try{return unzipSync(buffer,{filter:file=>file.name==='ppt/presentation.xml'||file.name==='ppt/_rels/presentation.xml.rels'||/^ppt\/slides\/slide\d+\.xml$/.test(file.name)});}catch{throw new Error('PPTX 解压失败，文件可能损坏');}
}
async function parsePptx(buffer:Buffer):Promise<MaterialPage[]>{
 const files=pptxFiles(buffer),presentation=files['ppt/presentation.xml'],relationships=files['ppt/_rels/presentation.xml.rels'];
 if(!presentation||!relationships)throw new Error('PPTX 缺少演示文稿结构');
 const ids=array(xml(presentation)?.presentation?.sldIdLst?.sldId),rels=array(xml(relationships)?.Relationships?.Relationship);
 if(!ids.length)throw new Error('PPTX 没有可读取的页面');if(ids.length>MAX_PAGES)throw new Error('材料最多支持 100 页');
 return ids.map((id,index)=>{
  const relationshipId=Object.entries(id).find(([key])=>key.startsWith('@_')&&key.endsWith(':id'))?.[1];
  const rel=rels.find(r=>r['@_Id']===relationshipId);
  if(!rel||rel['@_TargetMode']==='External'||typeof rel['@_Target']!=='string')throw new Error('PPTX 页面引用无效');
  const name=posix.normalize(posix.join('ppt',rel['@_Target']));if(!/^ppt\/slides\/slide\d+\.xml$/.test(name)||!files[name])throw new Error('PPTX 页面文件缺失');
  const text=texts(xml(files[name])).join('\n').trim();return {page:index+1,text,...(!text?{warning:EMPTY}:{})};
 });
}
async function parsePdf(buffer:Buffer):Promise<MaterialPage[]>{
 if(!buffer.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('PDF 文件头无效');
 const {getDocument,GlobalWorkerOptions}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 // PDF.js skips its Node default in Electron utility processes.
 GlobalWorkerOptions.workerSrc ||= import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
 const task=getDocument({data:new Uint8Array(buffer),disableFontFace:true,useSystemFonts:false,stopAtErrors:true,verbosity:0});
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void task.destroy();reject(new Error('PDF 解析超时，请拆分文件后重试'));},30000);});
 try{return await Promise.race([(async()=>{const doc=await task.promise;if(doc.numPages>MAX_PAGES)throw new Error('材料最多支持 100 页');const pages:MaterialPage[]=[];let total=0;
  for(let page=1;page<=doc.numPages;page++){const pdfPage=await doc.getPage(page);const content=await pdfPage.getTextContent();const text=content.items.map(item=>'str'in item?`${item.str}${item.hasEOL?'\n':' '}`:'').join('').trim();total+=text.length;if(total>MAX_MATERIAL_TEXT)throw new Error('材料提取文字超过 2 MiB 限制');pages.push({page,text,...(!text?{warning:EMPTY}:{})});pdfPage.cleanup();}return pages;})(),timeout]);}
 catch(e){if(e instanceof Error&&/100 页|限制|超时/.test(e.message))throw e;throw new Error('PDF 无法解析，可能已加密或文件损坏');}
 finally{if(timer)clearTimeout(timer);await task.destroy();}
}
export async function parseMaterial(buffer:Buffer,name:string):Promise<{pages:MaterialPage[];warning?:string}>{
 if(!Buffer.isBuffer(buffer)||!buffer.length)throw new Error('材料文件为空');
 if(buffer.length>MAX_MATERIAL_FILE_BYTES)throw new Error(MATERIAL_FILE_LIMIT_MESSAGE);
 const ext=extname(name).toLowerCase();let pages:MaterialPage[];
 if(ext==='.pdf')pages=await parsePdf(buffer);else if(ext==='.pptx')pages=await parsePptx(buffer);else if(['.txt','.md'].includes(ext)){
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{throw new Error('文字材料请使用 UTF-8 编码');}
  if(text.includes('\0'))throw new Error('文字材料包含不支持的二进制内容');
  pages=text.split('\f').map((text,index)=>({page:index+1,text:text.trim(),...(!text.trim()?{warning:'该页为空白。'}:{})}));
 }else throw new Error('材料格式仅支持 PDF、PPTX、TXT、MD');
 if(pages.length>MAX_PAGES)throw new Error('材料最多支持 100 页');
 if(pages.reduce((n,p)=>n+p.text.length,0)>MAX_MATERIAL_TEXT)throw new Error('材料提取文字超过 2 MiB 限制');
 const warnings=pages.filter(p=>p.warning);return {pages,...(warnings.length?{warning:`${warnings.length} 页存在解析警告；保留原始页码，未提取文字的页面需人工补充。`}:{})};
}
