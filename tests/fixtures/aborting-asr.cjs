'use strict';

process.on('message', message => {
  if (message.type === 'init') {
    const privateKeys = ['DEEPSEEK_API_KEY', 'TENCENT_SECRET_KEY', 'DOTENV_CONFIG_PATH', 'NODE_OPTIONS'];
    process.send({ type: privateKeys.some(key => process.env[key] !== undefined) ? 'error' : 'ready' });
  } else if (message.type === 'audio') {
    process.abort();
  } else if (message.type === 'finish') {
    process.send({type:'done'}, () => process.disconnect());
  }
});
