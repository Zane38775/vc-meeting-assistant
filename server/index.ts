import 'dotenv/config';
import {createApp} from './app';
const app=await createApp();
const port=Number(process.env.PORT||4318),host=process.env.HOST||'127.0.0.1';
await app.listen({host,port});
console.log(`VC Meeting Assistant: http://${host}:${port}`);
(process as any).parentPort?.postMessage({type:'server.ready',port});
process.send?.({type:'server.ready',port});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>void app.close().then(()=>process.exit(0)));
