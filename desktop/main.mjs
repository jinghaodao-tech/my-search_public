import { app, BrowserWindow, WebContentsView, ipcMain, session } from 'electron';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRIAL = process.argv.includes('--trial');
const APP_PRELOAD = path.join(ROOT, 'desktop', 'app-preload.cjs');
const BROWSER_PRELOAD = path.join(ROOT, 'desktop', 'browser-preload.cjs');
const BROWSER_HTML = path.join(ROOT, 'desktop', 'browser.html');
const BROWSER_HTML_URL = pathToFileURL(BROWSER_HTML).href;
const tabs = new Map();
let appWindow;
let browserWindow;
let activeTabId = null;
let serverProcess;
let serverPort;
let trialDbPath = null;
let stopping = false;
let externalSession;

function safeHttpsUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function trustedSender(event, expectedWindow, expectedUrl) {
  return Boolean(expectedWindow && event.sender === expectedWindow.webContents
    && event.senderFrame === expectedWindow.webContents.mainFrame
    && event.senderFrame.url === expectedUrl);
}

function trustedAppSender(event) {
  return Boolean(appWindow && event.sender === appWindow.webContents
    && event.senderFrame === appWindow.webContents.mainFrame
    && event.senderFrame.url === `http://localhost:${serverPort}/`);
}

function trustedBrowserToolbar(event) {
  return trustedSender(event, browserWindow, BROWSER_HTML_URL);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not allocate local server port')); return; }
      const { port } = address;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) throw new Error(`my-search server exited (${serverProcess.exitCode})`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* wait for the child to start */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the local my-search server');
}

async function startLocalServer() {
  serverPort = await freePort();
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(serverPort), CORS_ORIGIN: `http://localhost:${serverPort}`, NODE_ENV: 'development', API_KEY: '' };
  delete env.E2E_RESET_DB; delete env.E2E_DB_PATH; delete env.E2E_PORT; delete env.NODE_OPTIONS;
  if (TRIAL) {
    trialDbPath = path.join(os.tmpdir(), `my-search-desktop-trial-${process.pid}-${Date.now()}.db`);
    env.DB_PATH = trialDbPath;
    env.DEMO_MODE = 'true';
    env.AI_PROVIDER = 'disabled'; env.MOCK_AI_SUMMARY = 'false';
    delete env.ANTHROPIC_API_KEY; delete env.GEMINI_API_KEY;
  } else {
    env.DB_PATH = process.env.DB_PATH || 'data/cards.db';
    delete env.DEMO_MODE;
  }
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  serverProcess = spawn(process.env.MY_SEARCH_NODE || 'node', [tsxCli, 'server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  serverProcess.stdout.on('data', chunk => console.log(`[my-search] ${String(chunk).trimEnd()}`));
  serverProcess.stderr.on('data', chunk => console.error(`[my-search] ${String(chunk).trimEnd()}`));
  // The child server binds IPv4 loopback explicitly; use the same address here
  // so Linux runners do not resolve localhost to ::1 first.
  await waitForServer(`http://127.0.0.1:${serverPort}/healthz`);
}

function makeAppWindow() {
  appWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 650,
    webPreferences: { preload: APP_PRELOAD, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
  });
  appWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  appWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== `http://localhost:${serverPort}/` && !url.startsWith(`http://localhost:${serverPort}/`)) event.preventDefault();
  });
  appWindow.loadURL(`http://localhost:${serverPort}/`);
  appWindow.on('closed', () => { appWindow = null; });
}

function getActiveTab() { return activeTabId ? tabs.get(activeTabId) : null; }

function sendBrowserState() {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const state = {
    active: getActiveTab() ? { id: activeTabId, url: getActiveTab().view.webContents.getURL(), title: getActiveTab().view.webContents.getTitle(), canGoBack: getActiveTab().view.webContents.canGoBack(), canGoForward: getActiveTab().view.webContents.canGoForward() } : null,
    tabs: [...tabs.entries()].map(([id, tab]) => ({ id, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() })),
  };
  browserWindow.webContents.send('browser:state', state);
}

function layoutBrowserViews() {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const { width, height } = browserWindow.getContentBounds();
  for (const [id, tab] of tabs) tab.view.setBounds(id === activeTabId
    ? { x: 0, y: 104, width, height: Math.max(1, height - 104) }
    : { x: 0, y: height + 1, width: 1, height: 1 });
}

function setActiveTab(id) {
  if (!tabs.has(id)) return false;
  activeTabId = id;
  layoutBrowserViews();
  sendBrowserState();
  return true;
}

function openTab(rawUrl) {
  if (!browserWindow || browserWindow.isDestroyed()) makeBrowserWindow();
  if (tabs.size >= 8) throw new Error('ブラウザーは最大8タブです。不要なタブを閉じてください。');
  const url = safeHttpsUrl(rawUrl || 'https://example.com');
  if (!url) throw new Error('HTTPSのURLを指定してください。');
  const view = new WebContentsView({ webPreferences: {
    session: externalSession,
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    allowRunningInsecureContent: false, webviewTag: false,
  } });
  const id = randomUUID();
  tabs.set(id, { view });
  browserWindow.contentView.addChildView(view);
  activeTabId = id;
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, target) => { if (!safeHttpsUrl(target)) event.preventDefault(); });
  contents.on('will-redirect', (event, target) => { if (!safeHttpsUrl(target)) event.preventDefault(); });
  contents.on('will-download', event => event.preventDefault());
  contents.on('did-navigate', sendBrowserState);
  contents.on('did-navigate-in-page', sendBrowserState);
  contents.on('page-title-updated', sendBrowserState);
  contents.on('render-process-gone', sendBrowserState);
  contents.once('destroyed', () => { tabs.delete(id); if (activeTabId === id) activeTabId = tabs.keys().next().value ?? null; layoutBrowserViews(); sendBrowserState(); });
  layoutBrowserViews();
  contents.loadURL(url.href).catch(error => { console.error('Browser navigation failed', error); sendBrowserState(); });
  sendBrowserState();
  return id;
}

function makeBrowserWindow() {
  if (browserWindow && !browserWindow.isDestroyed()) { browserWindow.show(); return; }
  browserWindow = new BrowserWindow({
    width: 1200, height: 850, minWidth: 700, minHeight: 450, title: 'my-search 内蔵ブラウザー',
    webPreferences: { preload: BROWSER_PRELOAD, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
  });
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserWindow.loadFile(BROWSER_HTML);
  browserWindow.on('resize', layoutBrowserViews);
  browserWindow.on('closed', () => {
    for (const tab of tabs.values()) { browserWindow?.contentView.removeChildView(tab.view); tab.view.webContents.close(); }
    tabs.clear(); activeTabId = null; browserWindow = null;
  });
}

ipcMain.handle('desktop:open-browser', (event, rawUrl) => {
  if (!trustedAppSender(event)) throw new Error('Untrusted sender');
  if (!browserWindow || browserWindow.isDestroyed()) makeBrowserWindow(); else browserWindow.show();
  const url = rawUrl ? safeHttpsUrl(rawUrl) : null;
  if (rawUrl && !url) throw new Error('HTTPSのURLを指定してください。');
  if (url) openTab(url.href); else if (!tabs.size) openTab('https://example.com');
  else sendBrowserState();
  return true;
});

function registerBrowserAction(name, action) {
  ipcMain.handle(name, (event, ...args) => {
    if (!trustedBrowserToolbar(event)) throw new Error('Untrusted sender');
    return action(...args);
  });
}
registerBrowserAction('browser:state', () => {
  const active = getActiveTab();
  return { active: active ? { id: activeTabId, url: active.view.webContents.getURL(), title: active.view.webContents.getTitle(), canGoBack: active.view.webContents.canGoBack(), canGoForward: active.view.webContents.canGoForward() } : null,
    tabs: [...tabs.entries()].map(([id, tab]) => ({ id, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() })) };
});
registerBrowserAction('browser:open-tab', url => openTab(url));
registerBrowserAction('browser:select-tab', id => setActiveTab(id));
registerBrowserAction('browser:close-tab', id => {
  const tab = tabs.get(id); if (!tab) return false;
  browserWindow?.contentView.removeChildView(tab.view); tabs.delete(id);
  if (activeTabId === id) activeTabId = tabs.keys().next().value ?? null;
  tab.view.webContents.close(); layoutBrowserViews(); sendBrowserState(); return true;
});
registerBrowserAction('browser:navigate', rawUrl => {
  const url = safeHttpsUrl(rawUrl); const tab = getActiveTab();
  if (!url) throw new Error('HTTPSのURLを指定してください。');
  if (!tab) return openTab(url.href);
  return tab.view.webContents.loadURL(url.href);
});
registerBrowserAction('browser:back', () => { const tab = getActiveTab(); if (tab?.view.webContents.canGoBack()) tab.view.webContents.goBack(); });
registerBrowserAction('browser:forward', () => { const tab = getActiveTab(); if (tab?.view.webContents.canGoForward()) tab.view.webContents.goForward(); });
registerBrowserAction('browser:reload', () => getActiveTab()?.view.webContents.reload());
registerBrowserAction('browser:send-selection', async () => {
  const tab = getActiveTab();
  if (!tab) return { ok: false, reason: '開いているページがありません。' };
  const data = await tab.view.webContents.executeJavaScript(`(() => ({text: String(window.getSelection?.() || '').slice(0, 5000), title: String(document.title || '').slice(0, 200), url: location.href}))()`, true);
  const url = safeHttpsUrl(data.url);
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!url || !text) return { ok: false, reason: 'HTTPSページ上で引用候補の文章を選択してください。' };
  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.show(); appWindow.focus();
    appWindow.webContents.send('desktop:browser-clip', { text, title: String(data.title || '').slice(0, 200), url: url.href });
  }
  return { ok: true };
});

async function cleanupTrialDb() {
  if (!trialDbPath) return;
  const root = path.resolve(os.tmpdir()) + path.sep;
  const resolved = path.resolve(trialDbPath);
  if (!resolved.startsWith(root) || !path.basename(resolved).startsWith(`my-search-desktop-trial-${process.pid}-`)) {
    console.error('Refusing to remove a trial DB outside this process temporary path'); return;
  }
  for (const suffix of ['', '-wal', '-shm']) await fs.promises.rm(resolved + suffix, { force: true });
}

app.on('before-quit', event => {
  if (!serverProcess || stopping) return;
  event.preventDefault(); stopping = true;
  serverProcess.once('close', async () => { await cleanupTrialDb(); app.exit(0); });
  serverProcess.kill();
});

app.whenReady().then(async () => {
  externalSession = session.fromPartition('my-search-remote-pages');
  externalSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  externalSession.setPermissionCheckHandler(() => false);
  externalSession.on('will-download', event => event.preventDefault());
  await startLocalServer();
  makeAppWindow();
  app.on('activate', () => { if (!appWindow) makeAppWindow(); });
}).catch(error => { console.error(error); app.quit(); });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
