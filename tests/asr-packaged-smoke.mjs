// Exercise the shipped desktop, utility process, and native ASR child with a public WAV.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {_electron} from 'playwright';
import WebSocket from 'ws';

const base = 'http://127.0.0.1:4318';
assert.ok(process.argv[2], 'Usage: node tests/asr-packaged-smoke.mjs <packaged executable>');
const executable = await realpath(process.argv[2]);
const profile = await mkdtemp(path.join(tmpdir(), 'vc-asr-packaged-'));

function publicFrames(wav) {
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      assert.ok(start + size <= wav.length);
      const frames = [];
      for (let i = start; i < start + size; i += 6400) {
        frames.push(wav.subarray(i, Math.min(i + 6400, start + size)).toString('base64'));
      }
      return frames;
    }
    offset = start + size + size % 2;
  }
  throw new Error('Public WAV has no data chunk');
}

// Select only the ASR subprocess of the explicitly launched Electron instance.
function asrPid(servicePid, resources) {
  assert.ok(Number.isSafeInteger(servicePid) && servicePid > 1);
  const entry = path.join(resources, 'app.asar.unpacked', 'dist', 'server', 'local-worker.cjs');
  let children;
  if (process.platform === 'win32') {
    const command = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${servicePid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const json = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      command], {encoding:'utf8', windowsHide:true});
    children = [JSON.parse(json.trim() || '[]')].flat().map(p => [p.ProcessId, p.CommandLine]);
  } else {
    const lines = execFileSync('/bin/ps', ['-axww', '-o', 'ppid=,pid=,command='], {encoding:'utf8'});
    children = lines.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)/.exec(line))
      .filter(match => match && Number(match[1]) === servicePid)
      .map(match => [Number(match[2]), match[3]]);
  }
  const workers = children.filter(([, command]) => command?.includes(entry));
  assert.equal(workers.length, 1, 'Expected one packaged ASR process parented by the test service');
  return workers[0][0];
}

function session(url, cookie) {
  const socket = new WebSocket(url, {headers:{cookie, origin:base}});
  const messages = [];
  let failure;
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  socket.on('error', e => { failure = e; });
  return {
    messages,
    send: command => socket.send(JSON.stringify(command)),
    close: () => socket.close(),
    async wait(predicate, label, from = 0) {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const recent = messages.slice(from);
        const found = recent.find(predicate);
        if (found) return found;
        const error = recent.find(m => m.type === 'error');
        if (error || failure || socket.readyState === WebSocket.CLOSED) {
          throw new Error(`${label}: ${error?.message || failure?.message || 'socket closed'}`);
        }
        await delay(10);
      }
      throw new Error(`Timed out waiting for ${label}. Events: ${messages.map(m => m.type).slice(-12)}`);
    },
  };
}

let desktop, live;
try {
  const env = {...process.env, DOTENV_CONFIG_PATH:path.join(profile,'test.env'), DEEPSEEK_API_KEY:'', ASR_PROVIDER:'local', ASR_MODEL_PROFILE:'xasr-480'};
  for (const name of ['ELECTRON_RUN_AS_NODE','VC_SERVER_URL','ASR_MODEL_DIR','ASR_HOTWORDS']) delete env[name];
  await writeFile(env.DOTENV_CONFIG_PATH, '\n');
  desktop = await _electron.launch({executablePath:executable, args:[`--user-data-dir=${profile}`], env, timeout:30000});
  const page = await desktop.firstWindow({timeout:30000});
  const runtime = await desktop.evaluate(({app}) => ({
    packaged:app.isPackaged, asar:app.getAppPath(), resources:process.resourcesPath, userData:app.getPath('userData'),
  }));
  assert.ok(runtime.packaged && runtime.asar.endsWith('app.asar'));
  assert.equal(await realpath(runtime.userData), await realpath(profile));
  const servicePid = () => desktop.evaluate(({app}) => app.getAppMetrics().find(p => p.name === 'VC Meeting Service')?.pid);
  const service = await servicePid();
  assert.ok(service, 'Expected live VC Meeting Service utility process');
  await page.waitForURL(base + '/**');
  const request = page.context().request;
  const post = async (route, data) => {
    const reply = await request.post(base + '/api' + route, {data});
    assert.equal(reply.status(), 200, `POST ${route} failed`);
    return reply.json();
  };
  await post('/auth/register', {email:'smoke@example.test',name:'ASR smoke',password:'public-test-only-password'});
  const {project} = await post('/projects', {name:'Packaged ASR test'});
  const {meeting} = await post(`/projects/${project.id}/meetings`, {title:'Public WAV', mode:'offline', demo:false, retainAudio:false});
  const {cookies} = await request.storageState();
  const cookie = 'vc_session=' + cookies.find(c => c.name === 'vc_session').value;
  const socketUrl = `ws://127.0.0.1:4318/api/meetings/${meeting.id}/live`;
  const snap = status => m => m.type === 'snapshot' && m.data.meeting.status === status;
  const ready = id => m => m.type === 'asr.ready' && m.requestId === id;

  live = session(socketUrl, cookie);
  await live.wait(m => m.type === 'snapshot', 'opening snapshot');
  live.send({type:'start', requestId:'cold-cancel'});
  await live.wait(snap('live'), 'cold start accepted');
  assert.ok(!live.messages.some(ready('cold-cancel')), 'Cold cancel must precede ready');
  live.close();

  live = session(socketUrl, cookie);
  await live.wait(snap('paused'), 'cold disconnect paused meeting');
  live.send({type:'resume', requestId:'fault-injection'});
  await live.wait(ready('fault-injection'), 'model loaded after cold cancellation');
  // Simulate an abrupt native crash. Never target Electron, the service, or an unrelated process.
  const beforeCrash = live.messages.length;
  const prior = live.messages.filter(m => m.type === 'snapshot').at(-1);
  const priorGaps = prior.data.segments.filter(s => s.gap).length;
  process.kill(asrPid(service, runtime.resources), 'SIGKILL');
  const interrupted = await live.wait(m => snap('paused')(m) && m.data.segments.filter(s => s.gap).length > priorGaps,
    'pause after ASR process exit', beforeCrash);
  assert.equal(await servicePid(), service, 'ASR crash must not restart the service');

  const frames = publicFrames(await readFile('models/local-asr/test_wavs/0.wav'));
  const beforeRetry = live.messages.length;
  live.send({type:'resume', requestId:'public-wave'});
  await live.wait(ready('public-wave'), 'replacement ASR process ready', beforeRetry);
  for (const [seq, pcm] of frames.entries()) {
    live.send({type:'audio', seq, capturedAt:Date.now(), pcm});
    if (seq < frames.length-1) await delay(200);
  }
  live.send({type:'stop'});
  const ended = await live.wait(snap('ended'), 'final segment persisted', beforeRetry);
  const events = live.messages.slice(beforeRetry);
  assert.deepEqual(events.filter(m => m.type === 'audio.ack').map(m => m.seq), frames.map((_,i) => i));
  assert.ok(events.some(m => m.type === 'transcript.partial'));
  assert.equal(ended.data.segments.filter(s => s.gap).length, interrupted.data.segments.filter(s => s.gap).length);
  assert.match(ended.data.segments.filter(s => s.source === 'asr' && s.final).map(s => s.text).join(' '), /星期三/);
  assert.equal(await servicePid(), service);
  console.log(JSON.stringify({coldCancellation:true, isolatedCrash:true, sameService:true, frames:frames.length,
    partials:events.filter(m => m.type === 'transcript.partial').length, publicWaveTail:true}));
} finally {
  live?.close();
  await desktop?.close();
  await rm(profile, {recursive:true, force:true, maxRetries:3, retryDelay:300});
}
