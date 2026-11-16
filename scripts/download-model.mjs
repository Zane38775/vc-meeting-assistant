import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream,existsSync} from 'node:fs';
import {mkdir,rename,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawnSync} from 'node:child_process';

export const MODEL={
 name:'sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16',
 url:'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2',
 bytes:458187351,sha256:'2b7c63322b32e5e0f2526043a1103366119ca58dd615cd7105a37c01db9553d7',
 license:'Apache-2.0',
 modelCard:'https://huggingface.co/csukuangfj/k2fsa-zipformer-bilingual-zh-en-t/raw/e2382758de9a0219b4efe682b95af30b399db3b8/README.md',
 documentation:'https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html#sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16-bilingual-chinese-english',
 files:[
  {name:'encoder-epoch-99-avg-1.int8.onnx',bytes:42980793,sha256:'db6f51551762e40e549166fe041ea3e45464370b595e9ad23f06478ec3794fbb'},
  {name:'decoder-epoch-99-avg-1.onnx',bytes:13877276,sha256:'89be509a83175261695bdef5fd1c7b9ab1129a663d1284e7ba9f8507b21e0906'},
  {name:'joiner-epoch-99-avg-1.int8.onnx',bytes:3228485,sha256:'bdda356d6f9b8c2d7cee9ee0e26075fa537490f7fd06520be408d287073667b9'},
  {name:'tokens.txt',bytes:56317,sha256:'a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3'},
  {name:'test_wavs/0.wav',bytes:321744,sha256:'7d93384ca14702cc584a7a33fe2fed92e89e708549161cb12ea38c916882103b'},
  {name:'test_wavs/1.wav',bytes:163244,sha256:'8bfb42c963e623ebab31b81ff4404867d07d3102507c87ac14577c4c61663b8c'}
 ]
};
export async function verifyFile(path,expected){
 const info=await stat(path);if(info.size!==expected.bytes)throw new Error(`Size mismatch: ${path}`);
 const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
 if(hash.digest('hex')!==expected.sha256)throw new Error(`SHA256 mismatch: ${path}`);
}
async function getText(url){const r=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`Documentation download failed (${r.status})`);return r.text();}
export async function downloadModel(){
 const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
 const dir=resolve(process.env.ASR_MODEL_DIR||join(root,'models','local-asr'));
 const archive=join(root,'work','local-asr-model.tar.bz2');await mkdir(join(root,'work'),{recursive:true});await mkdir(dir,{recursive:true});
 const haveFiles=MODEL.files.every(file=>existsSync(join(dir,file.name)));
 if(haveFiles){for(const file of MODEL.files)await verifyFile(join(dir,file.name),file);}
 else {
  if(!existsSync(archive)){
   console.log('Downloading verified local ASR model (437 MiB archive; runtime subset about 57 MiB)…');
   const response=await fetch(MODEL.url,{signal:AbortSignal.timeout(300000)});if(!response.ok||!response.body)throw new Error(`Model download failed (${response.status})`);
   let received=0;const limit=new Transform({transform(chunk,_encoding,callback){received+=chunk.length;callback(received>MODEL.bytes?new Error('Model download exceeds pinned size'):null,chunk);}});
   const temporary=`${archive}.partial`;await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(temporary));await verifyFile(temporary,MODEL);await rename(temporary,archive);
  }
  await verifyFile(archive,MODEL);
  // Only explicit regular-file members from the pinned archive are extracted.
  const result=spawnSync('tar',['-xjf',archive,'-C',dir,'--strip-components=1',...MODEL.files.map(file=>`${MODEL.name}/${file.name}`)],{stdio:'inherit',timeout:120000,windowsHide:true});
  if(result.error||result.status!==0)throw new Error('Model extraction failed; install tar/bsdtar and retry');
  for(const file of MODEL.files)await verifyFile(join(dir,file.name),file);
 }
 await writeFile(join(dir,'MODEL-PROVENANCE.json'),JSON.stringify({...MODEL,runtime:'sherpa-onnx-node@2.0.1',quantization:'encoder INT8, decoder FP32, joiner INT8',runtimeBytes:MODEL.files.slice(0,4).reduce((sum,f)=>sum+f.bytes,0)},null,2)+'\n');
 if(!existsSync(join(dir,'MODEL-CARD.md')))await writeFile(join(dir,'MODEL-CARD.md'),await getText(MODEL.modelCard));
 if(!existsSync(join(dir,'LICENSE')))await writeFile(join(dir,'LICENSE'),await getText('https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/af2d8d81dbfa61c4cea4c568da78f3982edca005/LICENSE'));
 if(!existsSync(join(dir,'LICENSE-ONNXRUNTIME.txt')))await writeFile(join(dir,'LICENSE-ONNXRUNTIME.txt'),await getText('https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE'));
 await writeFile(join(dir,'NOTICE.txt'),'Local ASR model: '+MODEL.name+'\nModel authors: community contributor pfluo; sherpa-onnx export by Fangjun Kuang / next-gen Kaldi team.\nModel source and license declaration: '+MODEL.modelCard+'\nRuntime: sherpa-onnx-node 2.0.1 (Apache-2.0); ONNX Runtime (MIT).\nThe archive includes multiple model variants; this distribution keeps only the verified streaming subset and two public test WAVs. Model weights are unchanged.\n');
 console.log(`Verified model ready: ${dir}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)downloadModel().catch(error=>{console.error(error.message);process.exitCode=1;});
