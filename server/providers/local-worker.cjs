'use strict';
// A child process keeps native inference and termination separate from the meeting service.
// API reference: https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples
const {join}=require('node:path');
let recognizer,stream,index=0,totalSamples=0,startSamples=0,lastText='',finished=false;

function emit(final=false){
 const result=recognizer.getResult(stream);
 const text=String(result.text||'').trim();
 if(text&&(final||text!==lastText)){
  process.send({type:'segment',segment:{index,text,final,startMs:Math.floor(startSamples/16),endMs:Math.floor(totalSamples/16)}});
  lastText=text;
 }
 return text;
}
function decode(){while(recognizer.isReady(stream))recognizer.decode(stream);}

function initialize(config){
 const {OnlineRecognizer}=require('sherpa-onnx-node');
 const hotwordsBuf=(config.hotwords||[]).join('\n');
 const {modelDir,files,modelType,modelingUnit}=config;
 const modelConfig={
  transducer:{encoder:join(modelDir,files.encoder),decoder:join(modelDir,files.decoder),joiner:join(modelDir,files.joiner)},
  tokens:join(modelDir,files.tokens),numThreads:config.numThreads||2,provider:'cpu',modelType,debug:0,
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
}

function end(type){
 finished=true;
 if(process.connected)process.send({type},()=>{if(process.connected)process.disconnect();});
}

process.on('message',message=>{
 if(finished)return;
 try{
  if(message.type==='init'){
   initialize(message.data);
   process.send({type:'ready'});
  }else if(message.type==='audio'){
   const bytes=Buffer.from(message.pcm);
   if(bytes.length%2||bytes.length>32000)throw new Error('invalid pcm');
   const samples=new Float32Array(bytes.length/2);
   for(let i=0;i<samples.length;i++)samples[i]=bytes.readInt16LE(i*2)/32768;
   totalSamples+=samples.length;
   stream.acceptWaveform({sampleRate:16000,samples});
   decode();
   if(recognizer.isEndpoint(stream)){
    if(emit(true))index++;
    recognizer.reset(stream);
    startSamples=totalSamples;
    lastText='';
   }else emit(false);
   process.send({type:'ack',seq:message.seq});
  }else if(message.type==='finish'){
   // Padding drains right-context lookahead; timestamps exclude synthetic silence.
   stream.acceptWaveform({sampleRate:16000,samples:new Float32Array(12800)});
   stream.inputFinished();
   decode();
   emit(true);
   end('done');
  }
 }catch{end('error');}
});
