'use strict';
// Runs all ONNX inference outside the HTTP/WebSocket event loop.
// API reference: https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples
const {parentPort,workerData}=require('node:worker_threads');
const {join}=require('node:path');
let recognizer,stream,index=0,totalSamples=0,startSamples=0,lastText='',finished=false;
function emit(final=false){
 const result=recognizer.getResult(stream);const text=String(result.text||'').trim();
 if(text&&(final||text!==lastText)){parentPort.postMessage({type:'segment',segment:{index,text,final,startMs:Math.floor(startSamples/16),endMs:Math.floor(totalSamples/16)}});lastText=text;}
 return text;
}
function decode(){while(recognizer.isReady(stream))recognizer.decode(stream);}
try{
 const {OnlineRecognizer}=require('sherpa-onnx-node');
 const hotwordsBuf=(workerData.hotwords||[]).join('\n');
 const {modelDir,files,modelType,modelingUnit}=workerData;
 const modelConfig={
  transducer:{encoder:join(modelDir,files.encoder),decoder:join(modelDir,files.decoder),joiner:join(modelDir,files.joiner)},
  tokens:join(modelDir,files.tokens),numThreads:workerData.numThreads||2,provider:'cpu',modelType,debug:0,
 };
 if(hotwordsBuf){
  modelConfig.modelingUnit=modelingUnit;
  modelConfig.bpeVocab=join(modelDir,'bpe.vocab');
 }
 recognizer=new OnlineRecognizer({
  featConfig:{sampleRate:16000,featureDim:80},modelConfig,
  decodingMethod:hotwordsBuf?'modified_beam_search':'greedy_search',
  ...(hotwordsBuf?{hotwordsBuf,hotwordsBufSize:Buffer.byteLength(hotwordsBuf),hotwordsScore:2,maxActivePaths:4}:{}),
  enableEndpoint:true,rule1MinTrailingSilence:2.4,rule2MinTrailingSilence:1.2,rule3MinUtteranceLength:20,
 });
 stream=recognizer.createStream();
 parentPort.on('message',message=>{
  if(finished)return;
  try{
   if(message.type==='audio'){
    const bytes=Buffer.from(message.pcm);if(bytes.length%2||bytes.length>32000)throw new Error('invalid pcm');
    const samples=new Float32Array(bytes.length/2);for(let i=0;i<samples.length;i++)samples[i]=bytes.readInt16LE(i*2)/32768;
    totalSamples+=samples.length;stream.acceptWaveform({sampleRate:16000,samples});decode();
    if(recognizer.isEndpoint(stream)){if(emit(true))index++;recognizer.reset(stream);startSamples=totalSamples;lastText='';}else emit(false);
    parentPort.postMessage({type:'ack',seq:message.seq});
   }else if(message.type==='finish'){
    // Padding drains right-context lookahead; timestamps exclude synthetic silence.
    stream.acceptWaveform({sampleRate:16000,samples:new Float32Array(12800)});stream.inputFinished();decode();emit(true);finished=true;parentPort.postMessage({type:'done'});parentPort.close();
   }
  }catch{finished=true;parentPort.postMessage({type:'error'});parentPort.close();}
 });
 parentPort.postMessage({type:'ready'});
}catch{parentPort.postMessage({type:'error'});parentPort.close();}
