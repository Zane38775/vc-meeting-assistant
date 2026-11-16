import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import {zipSync,strToU8} from 'fflate';
import {signTencentURL,mapTencentMessage,createTencentASR} from '../server/providers/tencent';
import {analyzeContext,decodeSSE,DeepSeekClient,sanitizePublicQuery,validateQuestionDrafts,summarizeMeeting} from '../server/providers/deepseek';
import {parseMaterial} from '../server/materials';

test('Tencent signer signs raw sorted V2 parameters, encodes signature, and never puts secret key on wire',()=>{
 const url=new URL(signTencentURL({appId:'12345',secretId:'sid',secretKey:'topsecret',engine:'16k_zh_en_speaker_2.0'}, {timestamp:100,nonce:42,voiceId:'voice-test'}));
 assert.equal(url.pathname,'/asr/v2/12345');
 const raw='asr.cloud.tencent.com/asr/v2/12345?engine_model_type=16k_zh_en_speaker_2.0&expired=3700&needvad=1&nonce=42&secretid=sid&timestamp=100&voice_format=1&voice_id=voice-test';
 assert.equal(url.searchParams.get('signature'),createHmac('sha1','topsecret').update(raw).digest('base64'));
 assert.equal(url.href.includes('topsecret'),false);
});
test('Tencent maps partial/final and revised final to same sentence ID; whole-stream final is separate',()=>{
 const base={code:0,voice_id:'v',sentences:{sentence:'内容',sentence_id:3,sentence_type:0,speaker_id:-1,start_time:500,end_time:800}};
 const partial=mapTencentMessage(base,'v',1000); assert.equal(partial.segments[0].final,false); assert.equal(partial.segments[0].speaker,'说话人待确认');
 const final=mapTencentMessage({...base,sentences:{...base.sentences,sentence_type:1,speaker_id:2}},'v',1001);
 assert.equal(final.segments[0].id,partial.segments[0].id); assert.equal(final.segments[0].final,true); assert.equal(final.done,false);
 assert.deepEqual(mapTencentMessage({code:0,final:1},'v',1002),{segments:[],done:true});
 assert.throws(()=>mapTencentMessage({code:4002,message:'secret URL'},'v'),/4002/);
 assert.throws(()=>mapTencentMessage({...base,sentences:{...base.sentences,start_time:-1}},'v'),/格式/);
});
test('SSE decoder survives split UTF-8, CRLF, comments and multiline event data',async()=>{
 const bytes=new TextEncoder().encode(': heartbeat\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\ndata: [DONE]\n\n');
 const stream=new ReadableStream<Uint8Array>({start(c){for(let i=0;i<bytes.length;i+=2)c.enqueue(bytes.slice(i,i+2));c.close();}});
 const out=[];for await(const data of decodeSSE(stream))out.push(data);
 assert.deepEqual(out,['{"text":\n"中文"}','[DONE]']);
});
test('search privacy boundary permits generic technical terms and rejects names, numbers, quotes and private context',()=>{
 assert.equal(sanitizePublicQuery('RAG hallucination benchmark'),'RAG hallucination benchmark');
 for(const q of ['秘密公司 RAG','RAG revenue 500000','a@b.com RAG','"internal strategy" RAG','RAG https://internal.local','ProjectOrchid RAG']) assert.throws(()=>sanitizePublicQuery(q),/公开技术/);
});
test('question provenance rejects invented segments and quotes; optional unsafe search query is removed',()=>{
 const input={projectName:'private',questions:[],materials:[],segments:[{id:'s1',text:'我们还没有基准测试',final:true,source:'asr' as const,speaker:'A',startMs:0,endMs:1,receivedAt:1}]};
 const q={text:'怎么验证？',reason:'指标尚未验证',quote:'没有基准测试',segmentIds:['s1'],focus:'next_validation',researchQuery:'秘密项目 RAG'};
 assert.equal(validateQuestionDrafts({questions:[q]},input).questions[0].researchQuery,undefined);
 assert.throws(()=>validateQuestionDrafts({questions:[{...q,segmentIds:['invented']}]},input),/来源/);
 assert.throws(()=>validateQuestionDrafts({questions:[{...q,quote:'达到99%'}]},input),/来源/);
});

test('coaching allows silence and a decision-relevant clarification grounded in this round only',()=>{
 const prior={id:'old',text:'我们有三个付费客户',final:true,source:'asr' as const,speaker:'A',startMs:0,endMs:1,receivedAt:1};
 const current={...prior,id:'new',text:'是三个付费还是三个试用，这里还没确认',startMs:2,endMs:3,receivedAt:3};
 const input={projectName:'test',questions:[],materials:[],segments:[prior,current],newSegmentIds:['new']};
 const question={text:'这三个是已经签约的付费客户，还是免费试用？',reason:'影响当前收入牵引力判断，需要区分付费与试用。',quote:'三个付费还是三个试用',segmentIds:['new'],focus:'clarification'};
 assert.deepEqual(validateQuestionDrafts({questions:[]},input),{questions:[]});
 assert.deepEqual(validateQuestionDrafts({questions:[question]},input),{questions:[question]});
 assert.deepEqual(validateQuestionDrafts({questions:[{...question,segmentIds:['old','new']}]},input).questions[0].segmentIds,['new']);
 assert.throws(()=>validateQuestionDrafts({questions:[question,question]},input),/格式/);
 assert.throws(()=>validateQuestionDrafts({questions:[{...question,quote:'三个付费客户',segmentIds:['old','new']}]},input),/新增.*来源/);
});

test('coaching request keeps revised and recent final text plus previously dismissed questions in its bounded context',async t=>{
 const previousKey=process.env.DEEPSEEK_API_KEY;
 process.env.DEEPSEEK_API_KEY='unit-test-only';
 t.after(()=>{if(previousKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previousKey;});
 const prior={id:'q1',text:'谁已签付费合同？',quote:'已进入试点',reason:'确认付费牵引力。',segmentIds:['s2'],status:'dismissed' as const,kind:'inference' as const,createdAt:0,evidenceIds:[]};
 const segments=Array.from({length:45},(_,i)=>({id:`s${i}`,text:`已完成的发言 ${i}`,final:true,source:'asr' as const,speaker:'A',startMs:i,endMs:i+1,receivedAt:i}));
 const mockFetch=t.mock.method(globalThis,'fetch',async(_url:RequestInfo|URL,init?:RequestInit)=>{
  const request=JSON.parse(init!.body as string);
  const context=JSON.parse(request.messages[1].content);
  assert.deepEqual(context.newSegmentIds,['s0','s44']);
  assert.equal(context.segments.length,40);
  assert.equal(context.segments[0].id,'s0');
  assert.equal(context.segments.at(-1).id,'s44');
  assert.deepEqual(context.questions,[prior]);
  return Response.json({choices:[{finish_reason:'stop',message:{content:'{"questions":[]}'}}]});
 });
 assert.deepEqual(await analyzeContext({projectName:'Private',segments,questions:[prior],materials:[],newSegmentIds:['s0','s44']}),{questions:[]});
 assert.equal(mockFetch.mock.callCount(),1);
});

test('coaching receives only bounded, source-verified public research and still needs fresh transcript grounding',async t=>{
 const previousKey=process.env.DEEPSEEK_API_KEY;
 process.env.DEEPSEEK_API_KEY='unit-test-only';
 t.after(()=>{if(previousKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previousKey;});
 const queries=['RAG benchmark','ASR accuracy','RAG evaluation','TTS latency','GPU throughput','API latency'];
 const evidence=queries.flatMap((query,index)=>Array.from({length:4},(_,result)=>({
  id:`ref-${index}-${result}`,query,title:'Technical source',url:`https://evidence.example/${index}/${result}`,snippet:'Supports English language only.',retrievedAt:index,
 })));
 evidence.push({...evidence[0],id:'unlinked-source'});
 const researchBriefs=queries.map((query,index)=>({
  query,updatedAt:index,status:'ready' as const,findings:evidence.filter(source=>source.query===query&&source.id!=='unlinked-source').map(source=>({
   sourceId:source.id,quote:'English language only',point:'仅限英文。',relevance:'涉及语种覆盖。',uncertainty:'中文表现待核实。',
  })),
 }));
 researchBriefs[5].findings.unshift(
  {...researchBriefs[5].findings[0],sourceId:'missing-id'},
  {...researchBriefs[5].findings[0],sourceId:'ref-0-0'},
  {...researchBriefs[5].findings[0],quote:'Chinese evaluation'},
 );
 const omitted=[...researchBriefs,{...researchBriefs[5],query:'ASR latency',updatedAt:100,status:'unavailable' as const}];
 const segment={id:'fresh',text:'我们还没有拿到正式的评测结果。',final:true,source:'asr' as const,speaker:'A',startMs:0,endMs:2,receivedAt:2};
 let sourceOnly=false;
 t.mock.method(globalThis,'fetch',async(_url:RequestInfo|URL,init?:RequestInit)=>{
  const request=JSON.parse(init!.body as string);
  const payload=JSON.parse(request.messages[1].content);
  assert.match(request.messages[0].content,/公开检索摘要/);
  assert.equal(payload.evidence,undefined);
  assert.equal(payload.researchBriefs,undefined);
  assert.deepEqual(payload.researchContext.map((brief:any)=>brief.query),queries.slice(1).reverse());
  assert.ok(payload.researchContext.every((brief:any)=>brief.findings.length===3));
  assert.deepEqual(payload.researchContext[0].findings.map((finding:any)=>finding.source.id),['ref-5-0','ref-5-1','ref-5-2']);
  assert.deepEqual(payload.researchContext[0].findings[0],{
   quote:'English language only',point:'仅限英文。',relevance:'涉及语种覆盖。',uncertainty:'中文表现待核实。',
   source:{id:'ref-5-0',url:'https://evidence.example/5/0',title:'Technical source'},
  });
  const questions=sourceOnly?[{text:'是否支持英文？',reason:'公开摘要中有相关线索。',focus:'technical_moat',quote:'English language only',segmentIds:['fresh']}]:[];
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({questions})}}]});
 });
 const input={projectName:'Fixture',segments:[segment],questions:[],materials:[],newSegmentIds:['fresh'],researchBriefs:omitted,evidence};
 assert.deepEqual(await analyzeContext(input),{questions:[]});
 sourceOnly=true;
 await assert.rejects(analyzeContext(input),/引用来源无法核实/);
});

test('a BP quote resolves to the specific material when multiple files have that page number',()=>{
 const first={id:'different-bp',projectId:'p',name:'A.pdf',createdAt:1,summary:'',status:'ready' as const,pages:[{page:1,text:'另一个项目材料段落'}]};
 const second={...first,id:'quoted-bp',name:'B.pdf',pages:[{page:1,text:'运行时端侧量化仍需验证'}]};
 const quote='端侧量化仍需验证';
 const draft={text:'如何验证？',reason:'尚待验证',quote,segmentIds:[],materialPage:1,focus:'technical_moat'};
 const input={projectName:'Test',materials:[first,second],questions:[],segments:[]};
 const question=validateQuestionDrafts({questions:[draft]},input).questions[0];
 assert.equal(question.materialId,'quoted-bp');
 assert.equal(question.materialPage,1);
 const latest={id:'today',text:'试点已经上线端侧模型',final:true,source:'asr' as const,speaker:'A',startMs:0,endMs:1,receivedAt:1};
 const liveInput={...input,segments:[latest],newSegmentIds:['today']};
 assert.equal(validateQuestionDrafts({questions:[{...draft,segmentIds:['today']}]},liveInput).questions[0].materialId,'quoted-bp');
 assert.throws(()=>validateQuestionDrafts({questions:[draft]},liveInput),/新增.*来源/);
});

test('DeepSeek reports sanitized HTTP errors and rejects incomplete JSON streams',async()=>{
 const denied=new DeepSeekClient({apiKey:'secret',fetch:async()=>new Response('leaked secret',{status:401})});
 await assert.rejects(denied.json('json','x'),/401/);
 const truncated=new DeepSeekClient({apiKey:'secret',fetch:async()=>new Response('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
 await assert.rejects(truncated.json('json','x'),/截断/);
});
test('DeepSeek cancels a stalled request and rejects empty or malformed model JSON',async()=>{
 const stalled=new DeepSeekClient({apiKey:'secret',timeoutMs:25,fetch:async(_url,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))});
 await assert.rejects(stalled.json('json','x'),/超时/);
 const bad=new DeepSeekClient({apiKey:'secret',fetch:async()=>Response.json({choices:[{message:{content:'not json'},finish_reason:'stop'}]})});
 await assert.rejects(bad.json('json','x'),/JSON/);
});
test('Tencent flushes queued audio before end and waits for server final, then closes',async()=>{
 const wss=new WebSocketServer({port:0}); await new Promise<void>(r=>wss.once('listening',r));
 const port=(wss.address() as {port:number}).port; const packets:(Buffer|string)[]=[]; const errors:Error[]=[];
 wss.on('connection',ws=>{ws.send(JSON.stringify({code:0}));ws.on('message',(data,binary)=>{packets.push(binary?Buffer.from(data as Buffer):data.toString()); if(!binary){ws.send(JSON.stringify({code:0,sentences:{sentence:'尾音',sentence_id:0,sentence_type:1,speaker_id:0,start_time:0,end_time:210}}));ws.send(JSON.stringify({code:0,final:1}));ws.close();}});});
 const segments:any[]=[];
 const asr=createTencentASR({onSegment:s=>segments.push(s),onStatus:()=>{},onError:e=>errors.push(e)},{appId:'123',secretId:'a',secretKey:'b',engine:'16k_zh_en_speaker_2.0'},{socketFactory:()=>new WebSocket(`ws://127.0.0.1:${port}`)});
 try{asr.write(Buffer.alloc(6400,1));asr.write(Buffer.alloc(320,2));await asr.finish();assert.equal(packets.length,3);assert.equal((packets[1] as Buffer).length,320);assert.equal(packets[2],'{"type":"end"}');assert.equal(segments[0].text,'尾音');assert.deepEqual(errors,[]);}finally{asr.close();for(const c of wss.clients)c.terminate();await new Promise<void>(r=>wss.close(()=>r()));}
});
test('material parser preserves text pages, rejects unsupported and oversized files',async()=>{
 const doc=await parseMaterial(Buffer.from('第一页\f第二页'),'note.md');assert.deepEqual(doc.pages.map(p=>p.text),['第一页','第二页']);
 await assert.rejects(parseMaterial(Buffer.alloc(100*1024*1024+1),'large.txt'),/100 MiB/);
 await assert.rejects(parseMaterial(Buffer.from('abc'),'file.exe'),/格式/);
 await assert.rejects(parseMaterial(Buffer.from(Array(102).fill('p').join('\f')),'many.txt'),/100/);
});
test('PPTX respects presentation order, retains blank slides and rejects expansion bombs',async()=>{
 const files={'ppt/presentation.xml':strToU8('<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="2" r:id="rB"/><p:sldId id="1" r:id="rA"/></p:sldIdLst></p:presentation>'),'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="rA" Target="slides/slide1.xml"/><Relationship Id="rB" Target="slides/slide2.xml"/></Relationships>'),'ppt/slides/slide1.xml':strToU8('<p:sld><a:t>first</a:t></p:sld>'),'ppt/slides/slide2.xml':strToU8('<p:sld/>')};
 const doc=await parseMaterial(Buffer.from(zipSync(files)),'deck.pptx'); assert.equal(doc.pages[0].text,'');assert.match(doc.pages[0].warning!,/图像|扫描/);assert.equal(doc.pages[1].text,'first');
 await assert.rejects(parseMaterial(Buffer.from(zipSync({'ppt/slides/slide1.xml':new Uint8Array(8*1024*1024)})),'bomb.pptx'),/压缩|膨胀|解压/);
});
test('PPTX relationship IDs are independent of XML attribute order',async()=>{
 const files={'ppt/presentation.xml':strToU8('<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rA" id="256"/></p:sldIdLst></p:presentation>'),'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="rA" Target="slides/slide1.xml"/></Relationships>'),'ppt/slides/slide1.xml':strToU8('<p:sld><a:t>visible</a:t></p:sld>')};
 assert.equal((await parseMaterial(Buffer.from(zipSync(files)),'deck.pptx')).pages[0].text,'visible');
});
function pdfFixture(count:number,withText=false):Buffer {
 const objects:string[]=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${count} /Kids [${Array.from({length:count},(_,i)=>`${i+3} 0 R`).join(' ')}] >>`];
 for(let i=0;i<count;i++)objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] ${withText?`/Resources << /Font << /F1 ${count+4} 0 R >> >> /Contents ${count+3} 0 R`:''} >>`);
 if(withText){const content='BT /F1 12 Tf 40 700 Td (Hello investment) Tj ET';objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');}
 let text='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${obj}\nendobj\n`;});const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length+1} >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(text);
}
test('PDF parses actual text, flags image/blank pages, rejects corrupt PDFs and page limits',async()=>{
 assert.match((await parseMaterial(pdfFixture(1,true),'text.pdf')).pages[0].text,/Hello investment/);
 const blank=await parseMaterial(pdfFixture(2),'scan.pdf');assert.equal(blank.pages.length,2);assert.match(blank.pages[1].warning!,/尚未进行 OCR/);
 await assert.rejects(parseMaterial(pdfFixture(101),'huge.pdf'),/100/);await assert.rejects(parseMaterial(Buffer.from('%PDF-broken'),'broken.pdf'),/无法解析/);
});
test('search sends only validated public query and returns actual HTTP citations',async()=>{
 const calls:any[]=[];const client=new DeepSeekClient({apiKey:'test',fetch:async(url,init)=>{calls.push({url,body:JSON.parse(init!.body as string)});return Response.json({results:[{title:'Paper',url:'https://papers.example/p1',snippet:'A benchmark'},{title:'Unsafe',url:'javascript:alert(1)',snippet:'x'}]});}});
 const evidence=await client.search('RAG benchmark');assert.deepEqual(calls,[{url:'https://api.deepseek.com/v1/tools/search',body:{query:'RAG benchmark',count:5,need_content:false}}]);assert.equal(evidence.length,1);assert.equal(evidence[0].url,'https://papers.example/p1');
 await assert.rejects(client.search('PrivateProject RAG'),/公开技术/);assert.equal(calls.length,1);
});

test('research briefs use public search excerpts and reject unverifiable citations',async()=>{
 const {summarizeResearch}=await import('../server/providers/deepseek');
 const previousFetch=globalThis.fetch,previousKey=process.env.DEEPSEEK_API_KEY;
 const evidence=[{id:'source-a',url:'https://example.test/paper',title:'Example benchmark',snippet:'The benchmark covers English only.',query:'RAG benchmark',retrievedAt:1}];
 const finding={sourceId:'source-a',quote:'covers English only',point:'该基准只覆盖英文。',relevance:'可用于核对检索增强的英文评测。',uncertainty:'中文效果仍待核实。'};
 let result={findings:[finding]};
 let payload:unknown;
 globalThis.fetch=async(_url,init)=>{
  const request=JSON.parse(init?.body as string);
  payload=JSON.parse(request.messages[1].content);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]});
 };
 process.env.DEEPSEEK_API_KEY='unit-test-only';
 try{
  assert.deepEqual(await summarizeResearch('RAG benchmark',evidence),[finding]);
  assert.deepEqual(payload,{query:'RAG benchmark',sources:[{id:'source-a',title:'Example benchmark',snippet:'The benchmark covers English only.'}]});
  result={findings:[{...finding,sourceId:'other-source'}]};
  await assert.rejects(summarizeResearch('RAG benchmark',evidence),/引用/);
  result={findings:[{...finding,quote:'covers Chinese too'}]};
  await assert.rejects(summarizeResearch('RAG benchmark',evidence),/引用/);
  result={findings:[{...finding,point:'The benchmark is English only.'}]};
  await assert.rejects(summarizeResearch('RAG benchmark',evidence),/中文/);
 }finally{
  globalThis.fetch=previousFetch;
  if(previousKey===undefined)delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY=previousKey;
 }
});

test('BP analysis preserves the legacy summary API and accepts only short quoted terms from the cited page',async()=>{
 const {analyzeMaterial,summarizeMaterial}=await import('../server/providers/deepseek');
 const oldFetch=globalThis.fetch,oldKey=process.env.DEEPSEEK_API_KEY;
 const pages=[{page:1,text:'The home party uses ACE-Step for synthesis.'},{page:2,text:'PALACE floor has an ACE logo.'},{page:3,text:'The model uses RAG_engine; xACE: ACE.'}];
 const term={term:'ACE-Step',page:1,quote:'uses ACE-Step for synthesis'};
 let calls=0;
 globalThis.fetch=async()=>{
  calls++;
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({
   items:[{page:1,quote:'uses ACE-Step for synthesis',note:'公司称使用该工具'}],unknowns:[],
   terms:[term,{...term,term:'ace-step'},{...term,page:2},{...term,term:'invented'},{...term,term:'Step',quote:'Step'},{term:'ACE',page:2,quote:'ACE floor'},
    {...term,term:'uses ACE-Step for synthesis and other words'},{term:'home party',page:1,quote:'The home party'},
    {term:'RAG',page:3,quote:'uses RAG'},{term:'ACE',page:3,quote:'ACE: ACE'}],
  })}}]});
 };
 process.env.DEEPSEEK_API_KEY='unit-test-only';
 try{
  const analysis=await analyzeMaterial(pages);
  assert.equal(calls,1);
  assert.match(analysis.summary,/公司称使用该工具/);
  assert.deepEqual(analysis.terms,[term,{term:'home party',page:1,quote:'The home party'},{term:'ACE',page:3,quote:'ACE: ACE'}]);
  assert.equal(await summarizeMaterial(pages),analysis.summary);
 }finally{
  globalThis.fetch=oldFetch;
  if(oldKey===undefined)delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY=oldKey;
 }
});

test('BP text produces source-verified repeated technical phrases without stopwords or word fragments',async()=>{
 const {repeatedMaterialTerms,validatedMaterialTerms}=await import('../shared/material-references');
 const pages=[
  {page:1,text:'Quantum-Ready Workflows. Bare Metal. Title uses five alpha beta gamma delta terms.'},
  {page:2,text:'quantum-ready workflows. Bare Metal. The thank you slide. Xhome party and RAG_front door.'},
  {page:3,text:'Quantum-Ready Workflows. The thank you slide. Xhome party and RAG_front door.'},
  {page:4,text:'The thank you slide. Xhome party and RAG_front door.'},
 ];
 const terms=repeatedMaterialTerms(pages);
 assert.ok(terms.some(term=>term.term==='Quantum-Ready Workflows'&&term.page===1&&term.quote.includes(term.term)));
 assert.ok(!terms.some(term=>/^(Bare Metal|thank you|home party|front door)$/i.test(term.term)));
 assert.deepEqual(validatedMaterialTerms(pages,terms),terms);
 assert.ok(repeatedMaterialTerms([{page:1,text:'alpha beta gamma delta epsilon; alpha beta gamma delta epsilon; alpha beta gamma delta epsilon'}])
  .every(term=>term.term.split(' ').length<=4));
 const fullPhrases=repeatedMaterialTerms([{page:1,text:'Advanced Edge Protocol. Advanced Edge Protocol. Advanced Edge Protocol. amber buried shard cobalt. violet buried shard silver. azure buried shard bronze.'}]);
 assert.deepEqual(fullPhrases.map(term=>term.term),['Advanced Edge Protocol']);
});

test('BP analysis gives repeated source phrases priority over AI candidates',async t=>{
 const {analyzeMaterial}=await import('../server/providers/deepseek');
 const prior=process.env.DEEPSEEK_API_KEY;
 process.env.DEEPSEEK_API_KEY='unit-test-only';
 t.after(()=>{if(prior===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=prior;});
 const ai={term:'Edge Sync',page:1,quote:'Explore Edge Sync'};
 const duplicate={term:'Quantum Workflow',page:1,quote:'Quantum Workflow'};
 t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[],unknowns:[],terms:[ai,duplicate]})}}]}));
 const text='Quantum Workflow. Explore Edge Sync. Quantum Workflow. Quantum Workflow.';
 const {terms}=await analyzeMaterial([{page:1,text}]);
 assert.deepEqual(terms.map(term=>term.term),['Quantum Workflow','Edge Sync']);
});

test('BP analysis caps an overlong valid model response without dropping its summary or terms',async()=>{
 const {analyzeMaterial}=await import('../server/providers/deepseek');
 const oldFetch=globalThis.fetch,oldKey=process.env.DEEPSEEK_API_KEY;
 const item={page:1,quote:'uses ACE-Step for synthesis',note:'公司称使用该工具'};
 const terms=[{term:'ACE-Step',page:1,quote:item.quote}];
 const response=(items: typeof item[])=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({
  items,unknowns:Array.from({length:9},(_,index)=>`待核实问题 ${index+1}`),terms,
 })}}]});
 let items=Array(15).fill(item);
 globalThis.fetch=async()=>response(items);
 process.env.DEEPSEEK_API_KEY='unit-test-only';
 try{
  const pages=[{page:1,text:'The project uses ACE-Step for synthesis.'}];
  const material=await analyzeMaterial(pages);
  assert.equal(material.summary.split('\n').filter(line=>line.startsWith('- 第 ')).length,12);
  assert.match(material.summary,/待核实问题 8/);
  assert.doesNotMatch(material.summary,/待核实问题 9/);
  assert.deepEqual(material.terms,terms);
  items=[{...item,quote:'fictional claim'},...items.slice(1)];
  const partial=await analyzeMaterial(pages);
  assert.match(partial.summary,/1 条.*未能核对/);
  assert.doesNotMatch(partial.summary,/fictional claim/);
  assert.equal(partial.summary.split('\n').filter(line=>line.startsWith('- 第 ')).length,12);
  assert.deepEqual(partial.terms,terms);
 }finally{
  globalThis.fetch=oldFetch;
  if(oldKey===undefined)delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY=oldKey;
 }
});

test('BP analysis retries malformed provider JSON once and leaves HTTP errors alone',async t=>{
 const {analyzeMaterial}=await import('../server/providers/deepseek');
 const previousKey=process.env.DEEPSEEK_API_KEY;
 process.env.DEEPSEEK_API_KEY='unit-test-only';
 t.after(()=>{if(previousKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previousKey;});
 const body=(content:string)=>Response.json({choices:[{finish_reason:'stop',message:{content}}]});
 let calls=0,mode='recover';
 t.mock.method(globalThis,'fetch',async()=>{
  calls++;
  if(mode==='rate-limit')return new Response(null,{status:429});
  if(mode==='invalid'||calls===1)return body('{ broken json }');
  return body('{"items":[],"unknowns":[],"terms":[]}');
 });
 const pages=[{page:1,text:'Plain source'}];
 assert.deepEqual((await analyzeMaterial(pages)).terms,[]);
 assert.equal(calls,2);
 calls=0;mode='invalid';
 await assert.rejects(analyzeMaterial(pages),/无效 JSON/);
 assert.equal(calls,2);
 calls=0;mode='rate-limit';
 await assert.rejects(analyzeMaterial(pages),/429/);
 assert.equal(calls,1);
});
test('Tencent reports queue overflow once and rejects finish after overflow',async()=>{
 const wss=new WebSocketServer({port:0});await new Promise<void>(r=>wss.once('listening',r));const port=(wss.address() as {port:number}).port;const errors:Error[]=[];
 const asr=createTencentASR({onSegment:()=>{},onStatus:()=>{},onError:e=>errors.push(e)},{appId:'123',secretId:'a',secretKey:'b',engine:'16k_zh_en_speaker_2.0'},{socketFactory:()=>new WebSocket(`ws://127.0.0.1:${port}`)});
 try{for(let i=0;i<6;i++)asr.write(Buffer.alloc(32000));assert.equal(errors.length,1);await assert.rejects(asr.finish(),/积压/);}finally{asr.close();for(const c of wss.clients)c.terminate();await new Promise<void>(r=>wss.close(()=>r()));}
});
test('Tencent waits for final confirmation with bounded timeout and explicit cancellation',async()=>{
 const wss=new WebSocketServer({port:0});await new Promise<void>(r=>wss.once('listening',r));const port=(wss.address() as {port:number}).port;wss.on('connection',ws=>ws.send(JSON.stringify({code:0})));
 const errors:Error[]=[];const config={appId:'123',secretId:'a',secretKey:'b',engine:'16k_zh_en_speaker_2.0'};const callbacks={onSegment:()=>{},onStatus:()=>{},onError:(e:Error)=>errors.push(e)};
 const make=()=>createTencentASR(callbacks,config,{socketFactory:()=>new WebSocket(`ws://127.0.0.1:${port}`),finishMs:50});
 const timed=make();let cancelled:ReturnType<typeof make>|undefined;
 try{timed.write(Buffer.alloc(6400));await assert.rejects(timed.finish(),/末尾结果超时/);assert.equal(errors.length,1);cancelled=make();const pending=cancelled.finish();cancelled.close();await assert.rejects(pending,/取消/);}finally{timed.close();cancelled?.close();for(const c of wss.clients)c.terminate();await new Promise<void>(r=>wss.close(()=>r()));}
});
test('meeting summary covers early and late records across bounded batches without fabricated provenance',async()=>{
 const oldFetch=globalThis.fetch,oldKey=process.env.DEEPSEEK_API_KEY;const batches:any[]=[];
 process.env.DEEPSEEK_API_KEY='unit-test-only';
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(init!.body as string);const input=JSON.parse(request.messages[1].content);batches.push(input.segments);const s=input.segments[0];return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({observations:[{segmentId:s.id,quote:s.text.slice(0,8),note:'该阶段的发言记录'}],inferences:[],openQuestions:[],suggestedActions:[]})}}]});};
 const segments=Array.from({length:350},(_,i)=>({id:`s${i}`,text:`第${i}条的独立发言。`+'内容'.repeat(60),final:true,source:'manual' as const,speaker:'A',startMs:i*1000,endMs:i*1000+900,receivedAt:1}));
 try{const summary=await summarizeMeeting({segments,questions:[],materials:[],projectName:'Private'});const ids=batches.flat().map(s=>s.id);assert.ok(ids.includes('s0'));assert.ok(ids.includes('s349'));assert.ok(batches.length>1);assert.ok(batches.every(batch=>JSON.stringify(batch).length<60000));assert.match(summary,/350/);assert.match(summary,/人工输入/);}finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=oldKey;}
});
