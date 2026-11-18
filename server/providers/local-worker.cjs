'use strict';

const {join} = require('node:path');

// This module only runs in a disposable child process. A native exception in
// ONNX initialization or decoding must never terminate the meeting service.
let recognizer;
let stream;
let index = 0;
let totalSamples = 0;
let startSamples = 0;
let lastText = '';
let finished = false;

function send(message) {
  if (process.connected) process.send(message, error => { if (error) process.exit(1); });
}

function complete(type) {
  finished = true;
  if (process.connected) process.send({type}, () => { if (process.connected) process.disconnect(); });
}

function emitTranscript(final) {
  const text = String(recognizer.getResult(stream).text || '').trim();
  if (text && (final || text !== lastText)) {
    send({type: 'segment', segment: {
      index, text, final, startMs: Math.floor(startSamples / 16), endMs: Math.floor(totalSamples / 16),
    }});
    lastText = text;
  }
  return text;
}

function decode() {
  while (recognizer.isReady(stream)) recognizer.decode(stream);
}

function initialize(config) {
  const {OnlineRecognizer} = require('sherpa-onnx-node');
  const {modelDir, files, modelType, modelingUnit, numThreads} = config;
  const hotwordsBuf = config.hotwords.join('\n');
  const modelConfig = {
    transducer: {encoder: join(modelDir, files.encoder), decoder: join(modelDir, files.decoder), joiner: join(modelDir, files.joiner)},
    tokens: join(modelDir, files.tokens), numThreads, provider: 'cpu', modelType, debug: 0,
  };
  if (hotwordsBuf) {
    modelConfig.modelingUnit = modelingUnit;
    modelConfig.bpeVocab = join(modelDir, 'bpe.vocab');
  }
  recognizer = new OnlineRecognizer({
    featConfig: {sampleRate: 16000, featureDim: 80}, modelConfig,
    decodingMethod: hotwordsBuf ? 'modified_beam_search' : 'greedy_search',
    ...(hotwordsBuf ? {hotwordsBuf, hotwordsBufSize: Buffer.byteLength(hotwordsBuf), hotwordsScore: 2, maxActivePaths: 4} : {}),
    enableEndpoint: true, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20,
  });
  stream = recognizer.createStream();
  send({type: 'ready'});
}

function acceptAudio(message) {
  const bytes = message.pcm;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length % 2 || bytes.length > 32000) throw new Error('Invalid PCM frame');
  const samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
  totalSamples += samples.length;
  stream.acceptWaveform({sampleRate: 16000, samples});
  decode();
  if (recognizer.isEndpoint(stream)) {
    if (emitTranscript(true)) index++;
    recognizer.reset(stream);
    startSamples = totalSamples;
    lastText = '';
  } else {
    emitTranscript(false);
  }
  send({type: 'ack', seq: message.seq});
}

process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  if (finished) return;
  try {
    if (message.type === 'init' && !recognizer) initialize(message);
    else if (message.type === 'audio' && stream) acceptAudio(message);
    else if (message.type === 'finish' && stream) {
      // Flush right-context lookahead without counting synthetic silence in timestamps.
      stream.acceptWaveform({sampleRate: 16000, samples: new Float32Array(12800)});
      stream.inputFinished();
      decode();
      emitTranscript(true);
      complete('done');
    } else throw new Error('Unexpected local recognizer command');
  } catch { complete('error'); }
});
