import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream,existsSync} from 'node:fs';
import {copyFile,mkdir,mkdtemp,rename,rm,stat,writeFile} from 'node:fs/promises';
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
 vocabulary:{
  name:'bpe.vocab',bytes:12564,sha256:'d0b642f3a2eacd5fadefdeff9e0e1358cab729647cbb7fe58cf738e1f7407029',
  source:'https://huggingface.co/csukuangfj/k2fsa-zipformer-bilingual-zh-en-t/blob/e2382758de9a0219b4efe682b95af30b399db3b8/data/lang_char_bpe/bpe.vocab',
  license:'Apache-2.0',
 },
 files:[
  {name:'encoder-epoch-99-avg-1.int8.onnx',bytes:42980793,sha256:'db6f51551762e40e549166fe041ea3e45464370b595e9ad23f06478ec3794fbb'},
  {name:'decoder-epoch-99-avg-1.onnx',bytes:13877276,sha256:'89be509a83175261695bdef5fd1c7b9ab1129a663d1284e7ba9f8507b21e0906'},
  {name:'joiner-epoch-99-avg-1.int8.onnx',bytes:3228485,sha256:'bdda356d6f9b8c2d7cee9ee0e26075fa537490f7fd06520be408d287073667b9'},
  {name:'tokens.txt',bytes:56317,sha256:'a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3'},
  {name:'test_wavs/0.wav',bytes:321744,sha256:'7d93384ca14702cc584a7a33fe2fed92e89e708549161cb12ea38c916882103b'},
  {name:'test_wavs/1.wav',bytes:163244,sha256:'8bfb42c963e623ebab31b81ff4404867d07d3102507c87ac14577c4c61663b8c'}
 ]
};
export const XASR_MODEL={
 profile:'xasr-480',
 name:'sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05',
 url:'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2',
 bytes:133895136,sha256:'fa5f63d618e5a01526e275a358bb7772e403f84808a4769fba52cffd8160bf74',
 license:'Apache-2.0',
 modelCard:'https://huggingface.co/GilgameshWind/X-ASR-zh-en',
 vocabulary:{
  name:'bpe.vocab',bytes:69594,sha256:'28fc94d67aae53d8c58010fcfb16fc8c2f8dd263e03f3490c98210e354e8f914',
  derivedFrom:{name:'bpe.model',bytes:119265,sha256:'f87a38025a5fdd1e4e9591f6a44bb81295097ce0b80df6f4ab9f44e52c64ca5f'},
  derivation:'Export of SentencePiece ID-to-piece and scores from the same pinned upstream archive, in ID order, using SentencePiece 0.2.1.',
  license:'Apache-2.0',
 },
 files:[
  {name:'encoder.int8.onnx',bytes:155278641,sha256:'908596dcc137a73b95be908ca55e88caa1b3dbbe8027c171615f4b0609c5eb1e'},
  {name:'decoder.onnx',bytes:11309084,sha256:'a1cbc9eac2d5e3fb6617a218c67ad6daaa7f4e0fd225f08b2c22ab0413c8c257'},
  {name:'joiner.int8.onnx',bytes:2581422,sha256:'aedb7fa697b2ab43f20499826fff7c997eea7d67db77be97769aeeeb726e63b3'},
  {name:'tokens.txt',bytes:58806,sha256:'b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c'},
 ],
};
export async function verifyFile(path,expected){
 const info=await stat(path);if(info.size!==expected.bytes)throw new Error(`Size mismatch: ${path}`);
 const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
 if(hash.digest('hex')!==expected.sha256)throw new Error(`SHA256 mismatch: ${path}`);
}
async function getText(url){const r=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`Documentation download failed (${r.status})`);return r.text();}
async function prepareFiles(dir,archive,model){
 if(!model.files.every(file=>existsSync(join(dir,file.name)))){
  if(!existsSync(archive)){
   console.log(`Downloading ${model.name} (${Math.round(model.bytes/1024/1024)} MiB archive)…`);
   const response=await fetch(model.url,{signal:AbortSignal.timeout(300000)});if(!response.ok||!response.body)throw new Error(`Model download failed (${response.status})`);
   let received=0;const limit=new Transform({transform(chunk,_encoding,callback){received+=chunk.length;callback(received>model.bytes?new Error('Model download exceeds pinned size'):null,chunk);}});
   const temporary=`${archive}.${process.pid}.partial`;
   try{
    await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(temporary));
    await verifyFile(temporary,model);
    await rename(temporary,archive);
   }finally{await rm(temporary,{force:true});}
  }
  await verifyFile(archive,model);
  // Only explicit regular-file members from the pinned archive are extracted.
  const result=spawnSync('tar',['-xjf',archive,'-C',dir,'--strip-components=1',...model.files.map(file=>`${model.name}/${file.name}`)],{stdio:'inherit',timeout:120000,windowsHide:true});
  if(result.error||result.status!==0)throw new Error('Model extraction failed; install tar/bsdtar and retry');
 }
 for(const file of model.files)await verifyFile(join(dir,file.name),file);
}
async function prepareXASR(root,dir){
 const target=join(dir,XASR_MODEL.profile);
 const existing=existsSync(target);
 const installation=existing?target:await mkdtemp(join(dir,'.xasr-480-'));
 try{
  await prepareFiles(installation,join(root,'work','local-asr-xasr-480.tar.bz2'),XASR_MODEL);
  const vocabulary=join(root,'scripts','model-assets','xasr-480-bpe.vocab');
  await verifyFile(vocabulary,XASR_MODEL.vocabulary);
  const installedVocabulary=join(installation,XASR_MODEL.vocabulary.name);
  await copyFile(vocabulary,installedVocabulary);
  await verifyFile(installedVocabulary,XASR_MODEL.vocabulary);
  for(const license of ['LICENSE','LICENSE-ONNXRUNTIME.txt'])await copyFile(join(dir,license),join(installation,license));
  await writeFile(join(installation,'MODEL-CARD.md'),`# X-ASR-zh-en 480 ms\n\nAuthor: X-ASR project contributors. Source: [official model card](${XASR_MODEL.modelCard}). License: Apache-2.0.\n\nThis package uses the sherpa-onnx INT8 streaming release and its matching SentencePiece vocabulary. Model weights are unchanged.\n`);
  await writeFile(join(installation,'MODEL-PROVENANCE.json'),JSON.stringify({
   ...XASR_MODEL,runtime:'sherpa-onnx-node@2.0.1',quantization:'encoder INT8, decoder FP32, joiner INT8',
   runtimeBytes:XASR_MODEL.files.reduce((sum,f)=>sum+f.bytes,XASR_MODEL.vocabulary.bytes),
  },null,2)+'\n');
  if(!existing)await rename(installation,target);
 }finally{
  if(!existing)await rm(installation,{recursive:true,force:true});
 }
 console.log(`Verified model ready: ${target}`);
}
export async function downloadModel(){
 const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
 const dir=resolve(process.env.ASR_MODEL_DIR||join(root,'models','local-asr'));
 const archive=join(root,'work','local-asr-model.tar.bz2');await mkdir(join(root,'work'),{recursive:true});await mkdir(dir,{recursive:true});
 await prepareFiles(dir,archive,MODEL);
 const vocabulary=join(root,'scripts','model-assets','zipformer-bpe.vocab');
 await verifyFile(vocabulary,MODEL.vocabulary);
 const installedVocabulary=join(dir,MODEL.vocabulary.name);
 await copyFile(vocabulary,installedVocabulary);
 await verifyFile(installedVocabulary,MODEL.vocabulary);
 await writeFile(join(dir,'MODEL-PROVENANCE.json'),JSON.stringify({...MODEL,runtime:'sherpa-onnx-node@2.0.1',quantization:'encoder INT8, decoder FP32, joiner INT8',runtimeBytes:MODEL.files.slice(0,4).reduce((sum,f)=>sum+f.bytes,MODEL.vocabulary.bytes)},null,2)+'\n');
 if(!existsSync(join(dir,'MODEL-CARD.md')))await writeFile(join(dir,'MODEL-CARD.md'),await getText(MODEL.modelCard));
 if(!existsSync(join(dir,'LICENSE')))await writeFile(join(dir,'LICENSE'),await getText('https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/af2d8d81dbfa61c4cea4c568da78f3982edca005/LICENSE'));
 if(!existsSync(join(dir,'LICENSE-ONNXRUNTIME.txt')))await writeFile(join(dir,'LICENSE-ONNXRUNTIME.txt'),await getText('https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE'));
 await writeFile(join(dir,'NOTICE.txt'),'Local ASR model: '+MODEL.name+'\nModel authors: community contributor pfluo; sherpa-onnx export by Fangjun Kuang / next-gen Kaldi team.\nModel source and license declaration: '+MODEL.modelCard+'\nRuntime: sherpa-onnx-node 2.0.1 (Apache-2.0); ONNX Runtime (MIT).\nThe upstream archive includes multiple model variants. The source checkout keeps the verified streaming subset and two public test WAVs; the desktop distribution excludes test WAVs. Model weights are unchanged.\n');
 console.log(`Verified model ready: ${dir}`);
 await prepareXASR(root,dir);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)downloadModel().catch(error=>{console.error(error.message);process.exitCode=1;});
