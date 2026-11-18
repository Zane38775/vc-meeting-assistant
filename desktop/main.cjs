const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

function parseServerUrl(value) {
  if (!value) return new URL('http://127.0.0.1:4318');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('VC_SERVER_URL 必须是 HTTPS 服务根地址，例如 https://meeting.example.com');
  }
  return url;
}
function allowedOrigin(value, origin) {
  try {return new URL(value).origin === origin;} catch {return false;}
}
function allowedMaterialFileUrl(value, origin) {
  try {
    const url = new URL(value);
    return ['http:','https:'].includes(url.protocol) && url.origin === origin
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/api\/materials\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/file$/i.test(url.pathname);
  } catch {return false;}
}
function supportsLoopback(platform, version) {
  if (platform === 'win32') return true;
  const [major,minor] = String(version).split('.').map(Number);
  return platform === 'darwin' && (major > 14 || major === 14 && minor >= 2);
}
function canRequestCapture({origin, targetOrigin, topFrame, armedUntil, mode, permission, mediaTypes, now = Date.now()}) {
  if (!topFrame || !allowedOrigin(origin, targetOrigin) || armedUntil < now) return false;
  if (permission === 'display-capture') return mode === 'online';
  return permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every(t => t === 'audio');
}

async function ensureFreePort() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error('本地端口 4318 已被占用。请关闭已有的会议助手服务后重试。')));
    probe.listen(4318, '127.0.0.1', () => probe.close(resolve));
  });
}

async function launch() {
  const {app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell, utilityProcess} = require('electron');
  let window;
  let child;
  let shuttingDown = false;
  let armedUntil = 0;
  let captureMode;
  let serviceReady = false;
  const serverUrl = parseServerUrl(process.env.VC_SERVER_URL);
  const targetOrigin = serverUrl.origin;
  const ownContents = webContents => Boolean(window && !window.isDestroyed() && webContents === window.webContents);
  const ownFrame = frame => Boolean(window && !window.isDestroyed() && frame === window.webContents.mainFrame && allowedOrigin(frame.url, targetOrigin));

  app.on('before-quit', () => {shuttingDown = true; child?.kill();});
  app.on('window-all-closed', () => app.quit());
  app.on('second-instance', () => {if (window) {if (window.isMinimized()) window.restore(); window.focus();}});

  if (!process.env.VC_SERVER_URL) {
    await ensureFreePort();
    const entry = path.join(app.getAppPath(), 'dist', 'server', 'index.js');
    if (!fs.existsSync(entry)) throw new Error('找不到本地服务，请先运行 npm run build。');
    const userData = app.getPath('userData');
    fs.mkdirSync(userData, {recursive:true});
    const fallbackConfig = path.join(userData, '.env');
    if (!fs.existsSync(fallbackConfig)) {
      try {fs.writeFileSync(fallbackConfig, '# Local configuration; keep this file private.\nDEEPSEEK_API_KEY=\nDEEPSEEK_MODEL=deepseek-flash\n', {flag:'wx',mode:0o600});}
      catch (error) {if(error.code !== 'EEXIST') throw error;}
    }
    const executableDirectory = path.dirname(app.getPath('exe'));
    // On macOS the executable lives inside .app/Contents/MacOS; configuration
    // must stay outside the signed bundle, alongside the .app or in userData.
    const installDirectory = process.platform === 'darwin' ? path.resolve(executableDirectory, '../../..') : executableDirectory;
    const externalConfig = path.join(app.isPackaged
      ? process.env.PORTABLE_EXECUTABLE_DIR || installDirectory
      : app.getAppPath(), '.env');
    const configPath = process.env.DOTENV_CONFIG_PATH || (fs.existsSync(externalConfig) ? externalConfig : fallbackConfig);
    child = utilityProcess.fork(entry, [], {
      // ASAR is a virtual filesystem. Child process working directories must
      // point to a real OS directory, while module/static paths may use ASAR.
      cwd: app.isPackaged ? process.resourcesPath : app.getAppPath(),
      env: {...process.env, HOST:'127.0.0.1', PORT:'4318', DATA_DIR:userData,
        VC_ASR_EXEC_PATH:app.getPath('exe'),
        CLIENT_DIR:path.join(app.getAppPath(), 'dist', 'client'),
        DOTENV_CONFIG_PATH:configPath,
        ASR_MODEL_DIR:process.env.ASR_MODEL_DIR || path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'models', 'local-asr'),
      },
      serviceName:'VC Meeting Service', stdio:'pipe',
    });
    child.stdout?.on('data', chunk => process.stdout.write(chunk));
    child.stderr?.on('data', chunk => process.stderr.write(chunk));
    child.on('exit', code => {
      if (serviceReady && !shuttingDown) {
        dialog.showErrorBox('会议服务已停止', `本地会议服务意外退出（${code}）。为防止录音丢失，应用将关闭。请重新打开后继续。`);
        app.quit();
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {child.kill(); reject(new Error('本地会议服务启动超时，请检查配置或日志。'));}, 20000);
      child.once('exit', code => {clearTimeout(timer); reject(new Error(`本地会议服务无法启动（${code}）。`));});
      child.on('message', message => {
        if (message?.type === 'server.ready') {clearTimeout(timer); serviceReady = true; resolve();}
      });
    });
  }

  window = new BrowserWindow({
    width:1440, height:960, minWidth:1050, minHeight:700, show:false,
    title:'VC Meeting Assistant', backgroundColor:'#f5f7fa',
    webPreferences:{
      preload:path.join(__dirname, 'preload.cjs'), sandbox:true, contextIsolation:true,
      nodeIntegration:false, webSecurity:true, allowRunningInsecureContent:false,
      webviewTag:false, backgroundThrottling:false,
    },
  });
  const ses = window.webContents.session;
  const captureAllowed = (webContents, permission, details) => ownContents(webContents) && canRequestCapture({
    origin:details.requestingUrl || details.securityOrigin || '', targetOrigin,
    topFrame:details.isMainFrame === true, armedUntil, mode:captureMode, permission, mediaTypes:details.mediaTypes,
  });
  // Denying checks ensures actual requests go through the stricter handler,
  // including the camera/microphone mediaTypes distinction.
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => callback(captureAllowed(webContents, permission, details)));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!supportsLoopback(process.platform, process.getSystemVersion?.()) || !request.userGesture || !request.audioRequested || !ownFrame(request.frame)
      || !allowedOrigin(request.securityOrigin, targetOrigin) || captureMode !== 'online' || Date.now() > armedUntil) {
      callback(null); return;
    }
    try {
      const sources = await desktopCapturer.getSources({types:['screen'], thumbnailSize:{width:0,height:0}, fetchWindowIcons:false});
      if (!sources[0] || !ownFrame(request.frame) || Date.now() > armedUntil) {callback(null); return;}
      // Video is required by getDisplayMedia. The renderer only processes audio.
      callback({video:sources[0], audio:'loopback'});
    } catch {try {callback(null);} catch { /* frame destroyed during prompt */ }}
  });
  ipcMain.handle('capture:authorize', (event, mode) => {
    if (!ownContents(event.sender) || !ownFrame(event.senderFrame) || !['online','offline'].includes(mode)) throw new Error('录音权限请求被拒绝。');
    if (mode === 'online' && !supportsLoopback(process.platform, process.getSystemVersion?.())) throw new Error('系统音频采集需要 macOS 14.2 或更新版本，或 Windows。线下模式仍可使用麦克风。');
    captureMode = mode;
    armedUntil = Date.now() + 15000;
  });
  ipcMain.on('capture:release', event => {if (ownFrame(event.senderFrame)) {armedUntil = 0; captureMode = undefined;}});
  ipcMain.on('external:open', (event, value) => {
    if (!ownFrame(event.senderFrame) || typeof value !== 'string' || value.length > 8192) return;
    try {const url = new URL(value); if (['http:','https:'].includes(url.protocol) && !url.username && !url.password) void shell.openExternal(url.href);} catch { /* invalid link */ }
  });
  // Original-material links use target=_blank in the web UI. Download them
  // through this authenticated session, without creating a privileged popup.
  window.webContents.setWindowOpenHandler(({url}) => {
    if (ownFrame(window.webContents.mainFrame) && allowedMaterialFileUrl(url, targetOrigin)) {
      window.webContents.downloadURL(url);
    }
    return {action:'deny'};
  });
  ses.on('will-download', (_event, item, contents) => {
    if (!ownContents(contents) || !allowedMaterialFileUrl(item.getURLChain()[0], targetOrigin)) return;
    if (!item.getURLChain().every(url => allowedMaterialFileUrl(url, targetOrigin))) {
      item.cancel();
      void dialog.showMessageBox(window, {type:'error',title:'无法保存原文件',message:'资料请求被重定向，已停止下载。请重新登录后重试。'});
      return;
    }
    item.setSaveDialogOptions({
      title:'保存项目原文件', buttonLabel:'保存原文件',
      defaultPath:path.join(app.getPath('downloads'), path.basename(item.getFilename()) || '项目原文件'),
    });
    item.once('done', (_downloadEvent, state) => {
      if (state === 'interrupted' && !window.isDestroyed()) {
        void dialog.showMessageBox(window, {type:'error',title:'原文件下载失败',message:'请检查连接及文件访问权限，然后重试。'});
      }
    });
  });
  window.webContents.on('will-navigate', event => {if (!allowedOrigin(event.url, targetOrigin)) event.preventDefault();});
  window.webContents.on('will-frame-navigate', event => {if (!event.isMainFrame || !allowedOrigin(event.url, targetOrigin)) event.preventDefault();});
  window.webContents.on('will-redirect', event => {if (!allowedOrigin(event.url, targetOrigin)) event.preventDefault();});
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-start-navigation', event => {if (event.isMainFrame && !event.isSameDocument) {armedUntil = 0; captureMode = undefined;}});
  window.once('ready-to-show', () => window.show());
  await window.loadURL(serverUrl.href);
}

if (process.versions.electron && process.type === 'browser') {
  const {app, dialog} = require('electron');
  if (!app.requestSingleInstanceLock()) app.quit();
  else app.whenReady().then(launch).catch(error => {dialog.showErrorBox('启动失败', error.message); app.quit();});
}
module.exports = {parseServerUrl, allowedOrigin, canRequestCapture, supportsLoopback, allowedMaterialFileUrl};
