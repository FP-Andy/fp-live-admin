'use strict';
/**
 * FinePlay Highlight — 하이라이트 제작 로컬 앱.
 *
 * 왜 로컬인가: 클립을 합치고 점수판을 새기는 건 재인코딩이라 CPU 를 오래 문다.
 * 그걸 여럿이 동시에 서버에 시키면 서버가 죽는다(실제로 한 번 죽었다). 그래서
 * 무거운 일만 각자 PC 로 내리고, 서버는 FLA 로그를 파일로 내주는 창구만 한다.
 *
 * 화면은 콘솔의 '수동 태깅' 을 **그대로** 쓴다. UI 를 새로 짜면 두 벌이 되어
 * 반드시 어긋나므로, Next 를 이 앱 안에서 띄우고 그 페이지를 연다.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

const isPackaged = app.isPackaged;
// 개발 중엔 레포의 apps/web, 포장한 뒤엔 앱 안에 넣어둔 web 폴더.
const WEB_DIR = isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.join(__dirname, '..', 'web', '.next-standalone-out');

let serverProc = null;
let mainWindow = null;
let serverPort = 0;

/** 비어 있는 포트를 하나 얻는다. 고정 포트를 쓰면 두 개 띄웠을 때 부딪힌다. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 서버가 실제로 응답할 때까지 기다린다. 붙기 전에 창을 열면 흰 화면이 뜬다. */
function waitForServer(port, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('로컬 서버가 뜨지 않았습니다'));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

async function startServer() {
  const entry = path.join(WEB_DIR, 'server.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`화면 파일을 찾지 못했습니다: ${entry}`);
  }
  serverPort = await freePort();
  // Electron 의 node 로 Next 서버를 자식 프로세스로 띄운다. 같은 프로세스에서
  // require 하면 서버가 listen 을 잡고 앉아 창 쪽 이벤트 루프와 얽힌다.
  serverProc = fork(entry, [], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(serverPort),
      HOSTNAME: '127.0.0.1',
      // 이 앱에는 붙을 서버가 없다. 화면이 서버로 뻗는 길은 로컬 모드에서 전부 막힌다.
      // FHL_LOCAL_APP 은 미들웨어의 로그인 검사를 건너뛰게 하는 표식이다.
      NEXT_PUBLIC_API_BASE: '/api',
      FHL_LOCAL_APP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  serverProc.stdout?.on('data', (d) => process.stdout.write(`[web] ${d}`));
  serverProc.stderr?.on('data', (d) => process.stderr.write(`[web] ${d}`));
  await waitForServer(serverPort);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    title: 'FinePlay Highlight',
    backgroundColor: '#16161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/admin/highlight/manual`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    dialog.showErrorBox('시작하지 못했습니다', String(err && err.message ? err.message : err));
    app.quit();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (serverProc && !serverProc.killed) serverProc.kill();
});

// ── 화면이 부르는 것들 ────────────────────────────────────────────────────
ipcMain.handle('local:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  workDir: path.join(app.getPath('userData'), 'jobs'),
  home: os.homedir(),
}));

ipcMain.handle('local:reveal', (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  return true;
});

// ── 실제 작업 ─────────────────────────────────────────────────────────────
const { cutClips, mergeClips } = require('./runner');

const jobsRoot = () => path.join(app.getPath('userData'), 'jobs');
const jobDir = (id) => path.join(jobsRoot(), String(id).replace(/[^A-Za-z0-9_-]/g, ''));

/** 진행 상황을 창으로 흘린다. 화면은 이걸 받아 막대를 그린다. */
function report(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('local:progress', payload);
}

/** data:image/...;base64,... 를 파일로 떨군다. */
function writeDataUrl(dataUrl, outPath) {
  const comma = String(dataUrl || '').indexOf(',');
  if (comma < 0) throw new Error('그림 형식이 올바르지 않습니다');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
  return outPath;
}

ipcMain.handle('local:createJob', () => {
  // 시각으로 이름을 지어 결과 폴더가 시간순으로 쌓이게 한다.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  return { jobId: id, dir };
});

ipcMain.handle('local:cut', async (_e, { jobId, sources, ranges }) => {
  const dir = jobDir(jobId);
  return cutClips({
    sources,
    ranges,
    outDir: path.join(dir, 'clips'),
    onProgress: (p) => report({ phase: 'cutting', ...p }),
  });
});

ipcMain.handle('local:saveScoreboards', (_e, { jobId, images }) => {
  const dir = path.join(jobDir(jobId), 'sb');
  const out = {};
  Object.entries(images || {}).forEach(([key, dataUrl]) => {
    const [h, a] = key.split(':');
    out[key] = writeDataUrl(dataUrl, path.join(dir, `sb_${h}_${a}.png`));
  });
  return out;
});

ipcMain.handle('local:saveIntro', (_e, { jobId, dataUrl }) => (
  writeDataUrl(dataUrl, path.join(jobDir(jobId), 'intro.png'))
));

ipcMain.handle('local:merge', async (_e, { jobId, options }) => {
  const dir = jobDir(jobId);
  const outPath = path.join(dir, `하이라이트_${jobId}.mp4`);
  await mergeClips({
    clips: options.clips,
    workDir: path.join(dir, 'pieces'),
    outPath,
    intro: options.intro || null,
    scoreboard: options.scoreboard || null,
    sbImages: options.sbImages || {},
    sbHasLogo: !!options.sbHasLogo,
    onProgress: (p) => report({ phase: 'merging', ...p }),
  });
  // 조각과 클립은 지운다 — 원본만큼 크지는 않아도 경기마다 쌓이면 디스크를 먹는다.
  fs.rmSync(path.join(dir, 'clips'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'sb'), { recursive: true, force: true });
  return { outPath };
});
