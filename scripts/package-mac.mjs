import {packager} from '@electron/packager';
import {readFile,mkdir,cp} from 'node:fs/promises';
import path from 'node:path';
import {prepareMacNatives} from './prepare-mac-natives.mjs';
await prepareMacNatives();
const pkg=JSON.parse(await readFile('package.json','utf8'));
const outputs=await packager({dir:process.cwd(),name:'VC Meeting Assistant',platform:'darwin',arch:'arm64',electronVersion:pkg.devDependencies.electron,out:'release',overwrite:true,prune:true,
 appBundleId:'com.vcmeeting.assistant',appVersion:pkg.version,appCategoryType:'public.app-category.productivity',
 asar:{unpack:'{**/*.node,**/*.dylib,**/*.dll,**/local-worker.cjs,**/sherpa-onnx*/**/*,**/pdfjs-dist/**/*}'},
 ignore:[/^\/(?:\.git|\.env(?:\..*)?|release|work|data|models|tests|server|client|shared|scripts|docs|node_modules\/\.cache|node_modules\/sherpa-onnx-win-x64|node_modules\/@napi-rs\/canvas-win32-x64-msvc)(?:\/|$)/,/^\/(?:tsconfig\.json|vite\.config\.ts|package-lock\.json)$/],
 extendInfo:{LSMinimumSystemVersion:'14.2',NSMicrophoneUsageDescription:'用于在您主动开始会议时实时转写发言，语音识别在本机进行。',NSAudioCaptureUsageDescription:'用于在您主动开始线上会议录音时收取远端参会者声音。',NSScreenCaptureUsageDescription:'用于选择线上会议的音频来源，不保存屏幕画面。'},
 afterCopy:[async({buildPath})=>{for(const name of ['sherpa-onnx-darwin-arm64','@napi-rs/canvas-darwin-arm64'])await cp(path.join('node_modules',name),path.join(buildPath,'node_modules',name),{recursive:true})}]
});
for(const output of outputs){const resources=path.join(output,'VC Meeting Assistant.app','Contents','Resources');await mkdir(path.join(resources,'models'),{recursive:true});await cp('models/local-asr',path.join(resources,'models/local-asr'),{recursive:true,filter:s=>!s.includes('test_wavs')});await cp('scripts/Install-on-Mac.command',path.join(output,'Install-on-Mac.command'));}
console.log(JSON.stringify({outputs}));
