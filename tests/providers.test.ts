import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import {zipSync,strToU8} from 'fflate';
import {signTencentURL,mapTencentMessage,createTencentASR} from '../server/providers/tencent';
import {decodeSSE,DeepSeekClient,sanitizePublicQuery,validateQuestionDrafts,summarizeMeeting} from '../server/providers/deepseek';
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
 const q={text:'怎么验证？',reason:'指标尚未验证',quote:'没有基准测试',segmentIds:['s1'],researchQuery:'秘密项目 RAG'};
 assert.equal(validateQuestionDrafts({questions:[q]},input).questions[0].researchQuery,undefined);
 assert.throws(()=>validateQuestionDrafts({questions:[{...q,segmentIds:['invented']}]},input),/来源/);
 assert.throws(()=>validateQuestionDrafts({questions:[{...q,quote:'达到99%'}]},input),/来源/);
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
 await assert.rejects(parseMaterial(Buffer.alloc(30*1024*1024+1),'large.txt'),/30/);
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
