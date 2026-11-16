import {chromium} from 'playwright';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
// Public WAV is supplied as a simulated device; this test never opens a physical microphone.
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${path.resolve('models/local-asr/test_wavs/0.wav')}`]});
const context=await browser.newContext({viewport:{width:1512,height:982}}),page=await context.newPage();
let clicked=0,firstPartial=0;const errors=[];let partials=0;
page.on('pageerror',e=>errors.push(e.message));
page.on('websocket',ws=>ws.on('framereceived',f=>{try{const e=JSON.parse(String(f.payload));if(e.type==='transcript.partial'){partials++;firstPartial ||= Date.now()}}catch{}}));
try{
 const url='http://127.0.0.1:4318';
 let r=await context.request.post(url+'/api/auth/register',{data:{name:'本地模型验收',email:`asr-${Date.now()}@example.com`,password:'asr-test-password-only'}});assert.equal(r.status(),200);
 r=await context.request.post(url+'/api/projects',{data:{name:'本地实时转写验收'}});const pid=(await r.json()).project.id;
 r=await context.request.post(`${url}/api/projects/${pid}/meetings`,{data:{title:'公开样例 · 真实本地识别',mode:'offline',demo:false}});const mid=(await r.json()).meeting.id;
 await page.goto(url);
 await page.getByRole('button',{name:'本地实时转写验收',exact:true}).first().click();
 await page.getByRole('tab',{name:'会议记录',exact:true}).click();
 await page.getByRole('button',{name:/公开样例 · 真实本地识别/}).click();
 clicked=Date.now();await page.getByRole('button',{name:'开始采集',exact:true}).click();
 await page.waitForFunction(()=>document.body.innerText.includes('发言者（本地未分离）'),{},{timeout:15000});
 await new Promise(resolve=>setTimeout(resolve,10500));
 await page.getByRole('button',{name:'结束会议',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'结束并整理纪要',exact:true}).click();
 let snapshot;for(let i=0;i<30;i++){snapshot=await(await context.request.get(`${url}/api/meetings/${mid}`)).json();if(snapshot.meeting.status==='ended')break;await new Promise(r=>setTimeout(r,200))}
 assert.ok(partials>0);assert.ok(snapshot.segments.some(s=>s.source==='asr'&&!s.gap));assert.equal(snapshot.meeting.demo,false);assert.equal(snapshot.meeting.status,'ended');assert.deepEqual(errors,[]);
 const evidence={input:'official test_wavs/0.wav through Chrome fake microphone',physicalMicrophone:false,demo:false,firstPartialFromStartClickMs:firstPartial-clicked,partialCount:partials,segments:snapshot.segments,pageErrors:errors};
 await fs.writeFile('../../work/ui-local-asr-evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({firstPartialFromStartClickMs:evidence.firstPartialFromStartClickMs,partialCount:partials,finalSegments:snapshot.segments.length,pageErrors:errors}));
}catch(e){console.error(await page.locator('body').innerText());await page.screenshot({path:'../../work/ui-local-asr-failure.png',fullPage:true});throw e}finally{await browser.close()}
