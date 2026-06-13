'use strict';

/**
 * DS Agent — Electron Main Process (v2)
 *
 * Architecture:
 *   - Main window:  terminal HTML hosting xterm.js + pi pty
 *   - DeepSeek:     hidden BrowserView attached to the main window;
 *                   exposed via a "显示 DeepSeek" toggle in the terminal UI
 *   - HTTP shim:    127.0.0.1 server speaking OpenAI Chat Completions,
 *                   bridged via LlmBridge → DeepSeek BrowserView → DeepSeekClient
 *   - pi:           spawned with PI_CODING_AGENT_DIR pointing at userData/pi-home,
 *                   models.json pre-written to point at the HTTP shim
 */

const {
  app, BrowserWindow, BrowserView, session, Tray, Menu, nativeImage,
  globalShortcut, shell, ipcMain, dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { LlmBridge } = require('./llm-bridge');
const { createHttpServer } = require('./http-server');
const { DEFAULT_TEMPLATE: DEFAULT_PROMPT_TEMPLATE } = require('./protocol/build-prompt');
const piHome = require('./pi-home');
const { PiRunner } = require('./pi-runner');

// ─── Constants ───────────────────────────────────────────────────────
const IS_DEV = process.argv.includes('--dev');
const DEEPSEEK_URL = 'https://chat.deepseek.com';
const HEADER_HEIGHT = 36;
const CHROME_VERSION = '135.0.0.0';

// Native title-bar replacement. On Windows/Linux Chromium draws the
// min/max/close buttons inside an overlay area that respects our colours;
// on macOS the traffic-light buttons are kept automatically.
const TITLE_BAR_CONFIG = {
  titleBarStyle: 'hidden',
  titleBarOverlay: process.platform === 'darwin'
    ? undefined
    : { color: '#16161a', symbolColor: '#d8d8d8', height: HEADER_HEIGHT },
  // Hide the traffic lights on macOS keeps things uniform; leave them
  // visible (default) so users still have OS-level window controls.
  trafficLightPosition: process.platform === 'darwin' ? { x: 10, y: 10 } : undefined,
};

const PLATFORM_UA = process.platform === 'win32'
  ? 'Windows NT 10.0; Win64; x64'
  : process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : 'X11; Linux x86_64';
const CHROME_UA = `Mozilla/5.0 (${PLATFORM_UA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

// ─── State ───────────────────────────────────────────────────────────
let mainWindow = null;
let dsView = null;
let tray = null;
let isQuitting = false;
let deepseekVisible = false;
let bridge = null;
let httpServer = null;
let httpPort = 0;
let runner = null;
let logStream = null;
let promptEditorWindow = null;
let settingsWindow = null;

function defaultMode() { return 'expert'; }
function getMode() { return loadConfig().mode || defaultMode(); }
function setMode(v) {
  const valid = (v === 'quick' || v === 'expert') ? v : defaultMode();
  saveConfig({ mode: valid });
  return valid;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

const DEFAULT_STOPPED_RETRY_CONFIG = {
  maxRetries: 1,
  delayMs: 800,
  prompt: '继续',
};

function getStoppedRetryConfig() {
  const cfg = loadConfig().stoppedRetry || {};
  return {
    maxRetries: clampInt(cfg.maxRetries, DEFAULT_STOPPED_RETRY_CONFIG.maxRetries, 0, 5),
    delayMs: clampInt(cfg.delayMs, DEFAULT_STOPPED_RETRY_CONFIG.delayMs, 0, 10000),
    prompt: (typeof cfg.prompt === 'string' && cfg.prompt.trim()) ? cfg.prompt : DEFAULT_STOPPED_RETRY_CONFIG.prompt,
  };
}

function setStoppedRetryConfig(cfg) {
  const next = {
    maxRetries: clampInt(cfg && cfg.maxRetries, DEFAULT_STOPPED_RETRY_CONFIG.maxRetries, 0, 5),
    delayMs: clampInt(cfg && cfg.delayMs, DEFAULT_STOPPED_RETRY_CONFIG.delayMs, 0, 10000),
    prompt: (cfg && typeof cfg.prompt === 'string' && cfg.prompt.trim()) ? cfg.prompt.trim() : DEFAULT_STOPPED_RETRY_CONFIG.prompt,
  };
  saveConfig({ stoppedRetry: next });
  log('settings', { event: 'stopped-retry-updated', ...next });
  return next;
}

function resetStoppedRetryConfig() {
  const cur = loadConfig();
  delete cur.stoppedRetry;
  try { fs.writeFileSync(appConfigPath(), JSON.stringify(cur, null, 2), 'utf-8'); } catch (_) {}
  log('settings', { event: 'stopped-retry-reset' });
  return getStoppedRetryConfig();
}

// ─── F12 DevTools ────────────────────────────────────────────────────
function enableDevToolsShortcut(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      wc.toggleDevTools();
    }
  });
}

// ─── Context menu ────────────────────────────────────────────────────
function showContextMenu(webContents, params) {
  const hasSelection = params.selectionText && params.selectionText.trim().length > 0;
  const canCopy = hasSelection || params.editFlags.canCopy;
  const template = [
    { label: '复制', enabled: canCopy, accelerator: 'CmdOrCtrl+C',
      click: () => { if (hasSelection) webContents.copy(); } },
    { label: '粘贴', enabled: params.editFlags.canPaste, accelerator: 'CmdOrCtrl+V',
      click: () => webContents.paste() },
    { type: 'separator' },
    { label: '全选', enabled: params.editFlags.canSelectAll, accelerator: 'CmdOrCtrl+A',
      click: () => webContents.selectAll() },
  ];
  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: BrowserWindow.fromWebContents(webContents) });
}

// ─── Logging ─────────────────────────────────────────────────────────
function getLogPath() {
  const dir = path.join(os.homedir(), '.ds-agent', 'log');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'ds-agent.log');
}

function log(tag, payload) {
  try {
    if (!logStream) logStream = fs.createWriteStream(getLogPath(), { flags: 'a' });
    const line = JSON.stringify({ t: Date.now(), tag, ...payload }) + '\n';
    logStream.write(line);
    if (IS_DEV) console.log('[' + tag + ']', payload);
  } catch (_) {}
}

// ─── Persistent app config ───────────────────────────────────────────
function appConfigPath() {
  return path.join(app.getPath('userData'), 'app-config.json');
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(appConfigPath(), 'utf-8')); }
  catch (_) { return {}; }
}
function saveConfig(patch) {
  const cur = loadConfig();
  const next = Object.assign({}, cur, patch);
  try { fs.writeFileSync(appConfigPath(), JSON.stringify(next, null, 2), 'utf-8'); }
  catch (e) { log('config', { event: 'save-failed', message: e.message }); }
  return next;
}
function defaultWorkspace() {
  return os.homedir();
}

// ─── Prompt template (user-overridable) ──────────────────────────────
function getCurrentPromptTemplate() {
  const t = loadConfig().promptTemplate;
  return (typeof t === 'string' && t.trim()) ? t : DEFAULT_PROMPT_TEMPLATE;
}

function setCurrentPromptTemplate(template) {
  if (typeof template !== 'string') return;
  // Empty / whitespace-only → treat as "reset to default".
  if (!template.trim()) {
    const cur = loadConfig();
    delete cur.promptTemplate;
    try { fs.writeFileSync(appConfigPath(), JSON.stringify(cur, null, 2), 'utf-8'); } catch (_) {}
    log('prompt', { event: 'cleared' });
    return;
  }
  saveConfig({ promptTemplate: template });
  log('prompt', { event: 'updated', length: template.length });
}

// ─── Anti-fingerprint session config ─────────────────────────────────
function configureSession() {
  const ses = session.defaultSession;
  ses.setUserAgent(CHROME_UA);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const major = CHROME_VERSION.split('.')[0];
    details.requestHeaders['Sec-CH-UA'] =
      `"Chromium";v="${major}", "Google Chrome";v="${major}"`;
    details.requestHeaders['Sec-CH-UA-Platform'] =
      process.platform === 'win32' ? '"Windows"' :
      process.platform === 'darwin' ? '"macOS"' : '"Linux"';
    details.requestHeaders['Sec-CH-UA-Mobile'] = '?0';
    details.requestHeaders['User-Agent'] = CHROME_UA;
    callback({ requestHeaders: details.requestHeaders });
  });
}

// ─── Window construction ─────────────────────────────────────────────
function iconPath() {
  const ext = process.platform === 'win32' ? 'ico' : process.platform === 'darwin' ? 'icns' : 'png';
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', `icon.${ext}`),
    path.join(process.resourcesPath || '', 'assets', `icon.${ext}`),
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return candidates[0];
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, title: 'DS Agent', icon: iconPath(),
    backgroundColor: '#0e0e0f',
    ...TITLE_BAR_CONFIG,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'terminal.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'terminal', 'index.html'));

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  enableDevToolsShortcut(mainWindow.webContents);

  // Context menu is handled by the renderer (terminal.js) so xterm
  // selection can be captured — webContents.context-menu fires only
  // for DOM-level selection, which xterm bypasses.

  mainWindow.on('resize', () => syncDsViewBounds());
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createDeepSeekView() {
  dsView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setBrowserView(dsView);
  // Start with zero-size bounds so the view runs invisibly but the page
  // (preload, login cookies, etc.) stays alive across visibility toggles.
  dsView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  dsView.webContents.loadURL(DEEPSEEK_URL);

  dsView.webContents.on('did-finish-load', () => {
    log('deepseek', { event: 'did-finish-load', url: dsView.webContents.getURL() });
  });

  enableDevToolsShortcut(dsView.webContents);
  dsView.webContents.on('context-menu', (e, params) => {
    showContextMenu(dsView.webContents, params);
  });
}

function syncDsViewBounds() {
  if (!mainWindow || !dsView) return;
  if (!deepseekVisible) {
    dsView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    return;
  }
  const [w, h] = mainWindow.getContentSize();
  dsView.setBounds({
    x: 0, y: HEADER_HEIGHT,
    width: w,
    height: Math.max(0, h - HEADER_HEIGHT),
  });
}

function setDeepseekVisible(vis) {
  deepseekVisible = !!vis;
  syncDsViewBounds();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('view:deepseek-visible', deepseekVisible);
  }
  if (deepseekVisible && dsView) {
    try { dsView.webContents.focus(); } catch (_) {}
  } else if (mainWindow) {
    try { mainWindow.webContents.focus(); } catch (_) {}
  }
  log('view', { deepseekVisible });
}

// ─── Prompt editor window ────────────────────────────────────────────
function openPromptEditor() {
  if (promptEditorWindow && !promptEditorWindow.isDestroyed()) {
    promptEditorWindow.show();
    promptEditorWindow.focus();
    return;
  }
  promptEditorWindow = new BrowserWindow({
    width: 900, height: 720,
    title: '提示词编辑',
    parent: mainWindow || undefined,
    modal: false,
    backgroundColor: '#0e0e0f',
    autoHideMenuBar: true,
    ...TITLE_BAR_CONFIG,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'prompt-editor.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  promptEditorWindow.loadFile(path.join(__dirname, '..', 'renderer', 'prompt-editor', 'index.html'));
  if (IS_DEV) promptEditorWindow.webContents.openDevTools({ mode: 'detach' });
  enableDevToolsShortcut(promptEditorWindow.webContents);
  promptEditorWindow.webContents.on('context-menu', (e, params) => {
    showContextMenu(promptEditorWindow.webContents, params);
  });
  promptEditorWindow.on('closed', () => { promptEditorWindow = null; });
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 520, height: 420,
    title: '设置',
    parent: mainWindow || undefined,
    modal: false,
    backgroundColor: '#0e0e0f',
    autoHideMenuBar: true,
    ...TITLE_BAR_CONFIG,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
  if (IS_DEV) settingsWindow.webContents.openDevTools({ mode: 'detach' });
  enableDevToolsShortcut(settingsWindow.webContents);
  settingsWindow.webContents.on('context-menu', (e, params) => {
    showContextMenu(settingsWindow.webContents, params);
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ─── Tray ────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(iconPath());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => mainWindow && mainWindow.show() },
    { label: '显示 DeepSeek', click: () => { mainWindow && mainWindow.show(); setDeepseekVisible(true); } },
    { label: '终端',     click: () => setDeepseekVisible(false) },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; tray.destroy(); tray = null; app.quit(); } },
  ]);
  tray.setToolTip('DS Agent');
  tray.setContextMenu(menu);
  tray.on('double-click', () => mainWindow && mainWindow.show());
}

// ─── IPC ─────────────────────────────────────────────────────────────
function wireIpc() {
  ipcMain.on('debug:log', (_e, line) => {
    try {
      if (!logStream) logStream = fs.createWriteStream(getLogPath(), { flags: 'a' });
      logStream.write(line + '\n');
    } catch (_) {}
  });

  ipcMain.on('view:show-deepseek', () => setDeepseekVisible(true));
  ipcMain.on('view:hide-deepseek', () => setDeepseekVisible(false));
  ipcMain.handle('view:is-deepseek-visible', () => deepseekVisible);

  // Workspace controls — choose pi's cwd; restart pi to apply
  ipcMain.handle('workspace:get', () => {
    return runner ? (runner.getCwd() || defaultWorkspace()) : defaultWorkspace();
  });
  ipcMain.handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: runner ? runner.getCwd() : defaultWorkspace(),
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { changed: false, cwd: runner ? runner.getCwd() : defaultWorkspace() };
    }
    const newCwd = result.filePaths[0];
    if (runner) {
      runner.setCwd(newCwd);
      try { await runner.restart(); } catch (e) { log('workspace', { event: 'restart-failed', message: e.message }); }
    }
    saveConfig({ workspace: newCwd });
    log('workspace', { event: 'changed', cwd: newCwd });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('workspace:changed', newCwd);
    }
    return { changed: true, cwd: newCwd };
  });

  // Prompt template editor
  ipcMain.on('prompt:open-editor', () => openPromptEditor());
  ipcMain.handle('prompt:get-current', () => getCurrentPromptTemplate());
  ipcMain.handle('prompt:get-default', () => DEFAULT_PROMPT_TEMPLATE);
  ipcMain.handle('prompt:is-custom', () => {
    const t = loadConfig().promptTemplate;
    return typeof t === 'string' && t.trim().length > 0;
  });
  ipcMain.handle('prompt:set', (_e, template) => {
    setCurrentPromptTemplate(typeof template === 'string' ? template : '');
    return true;
  });
  ipcMain.handle('prompt:reset', () => {
    setCurrentPromptTemplate('');
    return true;
  });

  // Settings window + stopped retry config
  ipcMain.on('settings:open', () => openSettingsWindow());
  ipcMain.handle('settings:retry:get', () => getStoppedRetryConfig());
  ipcMain.handle('settings:retry:get-default', () => DEFAULT_STOPPED_RETRY_CONFIG);
  ipcMain.handle('settings:retry:is-custom', () => {
    const cfg = loadConfig().stoppedRetry;
    return !!(cfg && typeof cfg === 'object');
  });
  ipcMain.handle('settings:retry:set', (_e, cfg) => setStoppedRetryConfig(cfg || {}));
  ipcMain.handle('settings:retry:reset', () => resetStoppedRetryConfig());

  // Context menu for xterm (non-DOM selection)
  ipcMain.on('contextmenu:show', (event, payload) => {
    const wc = event.sender;
    const hasSelection = payload && typeof payload.selection === 'string' && payload.selection.length > 0;
    const template = [
      { label: '复制', enabled: hasSelection,
        click: () => wc.send('contextmenu:action', 'copy') },
      { type: 'separator' },
      { label: '粘贴',
        click: () => wc.send('contextmenu:action', 'paste') },
      { label: '全选',
        click: () => wc.send('contextmenu:action', 'selectAll') },
    ];
    const menu = Menu.buildFromTemplate(template);
    const win = BrowserWindow.fromWebContents(wc);
    menu.popup({ window: win, x: payload.x, y: payload.y });
  });

  // Agent mode toggle (expert / quick)
  ipcMain.handle('mode:get', () => getMode());
  ipcMain.on('mode:set', (_e, v) => {
    const next = setMode(v);
    log('mode', { event: 'changed', mode: next });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mode:changed', next);
    }
  });
}

// ─── App lifecycle ───────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Drop the default File/Edit/View menu bar — we don't expose any actions
  // through it. This affects every BrowserWindow this app creates.
  Menu.setApplicationMenu(null);

  configureSession();
  wireIpc();

  // 1. Bridge + HTTP server (must bind before pi-home.prepare writes the port)
  bridge = new LlmBridge({
    getTemplate: getCurrentPromptTemplate,
    getMode: getMode,
    getStoppedRetryConfig: getStoppedRetryConfig,
    log: (tag, p) => log(tag, p || {}),
  });
  httpServer = createHttpServer({ bridge, log: (tag, p) => log('http', { tag, ...(p || {}) }) });
  httpPort = await httpServer.listen();
  log('http', { event: 'listening', port: httpPort });

  // 2. pi-home configuration referring to the chosen port
  const piEnv = piHome.prepare(httpPort);
  log('pi-home', piEnv);

  // 3. Main terminal window
  createMainWindow();

  // 4. DeepSeek view (visible by default — user toggles back to terminal)
  createDeepSeekView();
  bridge.attach(dsView.webContents);
  setDeepseekVisible(true);

  // 5. pi runner (spawned on demand when renderer asks)
  const persistedWorkspace = loadConfig().workspace || defaultWorkspace();
  runner = new PiRunner({ piHome: piEnv.piHome, cwd: persistedWorkspace });
  mainWindow.webContents.once('did-finish-load', () => {
    runner.attachRenderer(mainWindow.webContents);
  });

  // 6. Tray
  createTray();

  // 7. Global toggle shortcut
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    if (!mainWindow) return;
    mainWindow.show();
    setDeepseekVisible(!deepseekVisible);
  });

  log('app', { event: 'ready', port: httpPort, piHome: piEnv.piHome, model: piEnv.modelId });
});

app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

app.on('before-quit', async (e) => {
  if (isQuitting) return;
  isQuitting = true;
  e.preventDefault();
  try {
    globalShortcut.unregisterAll();
    if (runner) await runner.dispose();
    if (httpServer) await httpServer.close();
  } catch (_) {}
  if (logStream) { try { logStream.end(); } catch (_) {} }
  app.exit(0);
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
  else createMainWindow();
});

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (!url.includes('chat.deepseek.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
});
