import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createLocalASR} from '../../server/providers/local.ts';

const callbacks = {onSegment() {}, onStatus() {}, onError() {}};
const opening = createLocalASR(callbacks, {profile: 'xasr-480', hotwords: ['home party']});
await delay(100);
opening.close();
await assert.rejects(opening.ready, /取消/);

const replacement = createLocalASR(callbacks, {profile: 'xasr-480', hotwords: ['home party']});
try {
  await replacement.ready;
  await replacement.finish();
  console.log('reopened after startup cancellation');
} finally {
  replacement.close();
}
