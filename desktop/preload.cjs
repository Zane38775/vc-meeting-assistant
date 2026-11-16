const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('vcDesktop', Object.freeze({
  platform:process.platform,
  authorizeCapture(mode) {
    if (!navigator.userActivation.isActive || !['online','offline'].includes(mode) || window.top !== window) {
      return Promise.reject(new Error('请通过开始录音按钮授权音频采集。'));
    }
    return ipcRenderer.invoke('capture:authorize', mode);
  },
  releaseCapture() {ipcRenderer.send('capture:release');},
}));

// No general IPC or shell API is exposed to page scripts. Only trusted user
// clicks on HTTP(S) links may request an external browser from this bridge.
function externalLink(event) {
  if (!event.isTrusted || (event.type === 'auxclick' && event.button !== 1)) return;
  const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement && node.href);
  if (!anchor) return;
  try {
    const url = new URL(anchor.href);
    if (url.origin === location.origin) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (['https:','http:'].includes(url.protocol)) ipcRenderer.send('external:open', url.href);
  } catch {event.preventDefault();}
}
document.addEventListener('click', externalLink, true);
document.addEventListener('auxclick', externalLink, true);
