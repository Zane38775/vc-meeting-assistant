import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
export async function prepareMacNatives(){
 const lock=JSON.parse(await readFile('package-lock.json','utf8'));const cache=path.resolve('work/npm-assets');await mkdir(cache,{recursive:true});
 for(const name of ['sherpa-onnx-darwin-arm64','@napi-rs/canvas-darwin-arm64']){
  const item=lock.packages[`node_modules/${name}`];if(!item?.integrity?.startsWith('sha512-')||!item.resolved?.startsWith('https://registry.npmjs.org/'))throw Error('Missing trusted locked native package');
  const archive=path.join(cache,name.replace(/[\/@]/g,'_')+'.tgz');let data=await readFile(archive).catch(()=>null);
  const valid=b=>b&&`sha512-${createHash('sha512').update(b).digest('base64')}`===item.integrity;
  if(!valid(data)){const r=await fetch(item.resolved,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error(`Native package download failed: ${r.status}`);data=Buffer.from(await r.arrayBuffer());if(!valid(data))throw Error('Native package integrity mismatch');await writeFile(archive,data);}
  const names=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split(/\r?\n/).filter(Boolean);if(names.some(n=>!n.startsWith('package/')||n.split('/').includes('..')))throw Error('Invalid package archive path');
  const destination=path.resolve('node_modules',name);await mkdir(destination,{recursive:true});execFileSync('tar',['-xzf',archive,'-C',destination,'--strip-components=1']);
 }
}
