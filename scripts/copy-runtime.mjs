import {copyFile,mkdir} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
await copyFile('server/providers/local-worker.cjs','dist/server/local-worker.cjs');
