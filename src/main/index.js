/**
 * DS Agent — Electron Main Process
 *
 * Responsibilities:
 *  - Window management (main chat window + control panel)
 *  - Tool execution via direct function calls (no HTTP server)
 *  - Request interception (webRequest API)
 *  - IPC bridge between renderer and tools
 *  - System tray
 */

const { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── Constants ────────────────────────────────────────────────
const IS_DEV = process.argv.includes('--dev');
const CHAT_URLS = ['https://chat.deepseek.com'];
const DEFAULT_CHAT_URL = CHAT_URLS[0];

// ─── Browser Fingerprint ─────────────────────────────────────
// Mimic a standard Chrome browser to avoid "risky environment" warnings.
// Electron's default UA contains "Electron/XX.X.X" which is easily flagged.

const CHROME_VERSION = '135.0.0.0';
// Platform-specific UA string — matches what a real Chrome browser would send
const PLATFORM_UA = process.platform === 'win32'
  ? 'Windows NT 10.0; Win64; x64'
  : process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : 'X11; Linux x86_64';
const CHROME_UA = `Mozilla/5.0 (${PLATFORM_UA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

let mainWindow = null;
let controlPanel = null;
let tray = null;
let isQuitting = false;

// ─── Tool Handler (direct require, no HTTP) ──────────────────
// Pre-load the tool handler so it's ready when IPC calls come in.
const { getToolList, handleToolCall, getWorkspace, setWorkspace } = require('../server/mcp-handler');

console.log(`[DS Agent] Tool handler loaded — ${getToolList().length} tools available`);

// ─── Session Setup ──────────────────────────────────────────
// Configure the default session to look like a normal Chrome browser.
function setupSession() {
  const ses = session.defaultSession;

  // 1. Override User-Agent for ALL requests (navigation, fetch, XHR, etc.)
  ses.setUserAgent(CHROME_UA);

  // 2. Intercept webRequest to strip Electron-specific headers
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    // Remove headers that leak Electron identity
    delete details.requestHeaders['Sec-CH-UA'];
    // Set a standard Chrome Sec-CH-UA
    details.requestHeaders['Sec-CH-UA'] =
      `"Chromium";v="${CHROME_VERSION.split('.')[0]}", "Google Chrome";v="${CHROME_VERSION.split('.')[0]}"`;
    details.requestHeaders['Sec-CH-UA-Platform'] =
      process.platform === 'win32' ? '"Windows"' : process.platform === 'darwin' ? '"macOS"' : '"Linux"';
    details.requestHeaders['Sec-CH-UA-Mobile'] = '?0';
    // Ensure User-Agent is consistent
    details.requestHeaders['User-Agent'] = CHROME_UA;
    callback({ requestHeaders: details.requestHeaders });
  });

  console.log('[DS Agent] Session configured — UA set to Chrome-like');
}

// ─── Main Window ─────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'DS Agent',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  mainWindow.loadURL(DEFAULT_CHAT_URL);

  // NOTE: Network hooks (fetch/XHR) and agent script injection are handled
  // by preload.js via <script> tag injection into the MAIN WORLD.
  // The preload runs before the page's own JavaScript, ensuring hooks are
  // installed early enough. No document.write() is used (it causes white screen).

  // Re-inject agent script on in-page navigation (e.g., SPA route changes)
  mainWindow.webContents.on('did-navigate-in-page', () => {
    const url = mainWindow.webContents.getURL();
    if (CHAT_URLS.some(chatUrl => url.includes(new URL(chatUrl).hostname))) {
      mainWindow.webContents.executeJavaScript(`
        if (window.dsAgent && !document.getElementById('ds-agent-injected')) {
          // Agent script will be re-injected by preload on next load
          console.log('[DS Agent] In-page navigation detected, agent still active');
        }
      `).catch(() => {});
    }
  });

  // Open DevTools in dev mode
  if (IS_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Control Panel Window ────────────────────────────────────
function createControlPanel() {
  if (controlPanel) {
    controlPanel.focus();
    return;
  }

  controlPanel = new BrowserWindow({
    width: 480,
    height: 640,
    title: 'DS Agent — Control Panel',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  controlPanel.loadFile(path.join(__dirname, '..', 'renderer', 'control-panel.html'));

  controlPanel.on('closed', () => {
    controlPanel = null;
  });
}

// ─── System Tray ─────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开 DS Agent', click: () => mainWindow?.show() },
    { label: '控制面板', click: () => createControlPanel() },
    { type: 'separator' },
    { label: 'DeepSeek', click: () => mainWindow?.loadURL('https://chat.deepseek.com') },
    { label: '退出', click: () => { isQuitting = true; tray?.destroy(); tray = null; app.quit(); } },
  ]);

  tray.setToolTip('DS Agent');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow?.show());
}

// ─── Request Interception ────────────────────────────────────
// NOTE: Request body modification (injecting tool hints) is now handled in the
// renderer process via fetch/XHR hooks. This is more reliable than webRequest API
// because webRequest.onBeforeRequest cannot reliably modify uploadData in all
// Electron versions, and the renderer hooks can access the same modified body
// that the original userscript used.

function setupRequestInterception() {
  // Logging only — actual body modification is done in renderer agent.js
  if (IS_DEV) {
    const ses = mainWindow.webContents.session;
    ses.webRequest.onCompleted(
      { urls: ['*://chat.deepseek.com/api/v0/*'] },
      (details) => {
        console.log(`[DS Agent] ${details.method} ${details.url} → ${details.statusCode}`);
      }
    );
  }
}

// ─── IPC Handlers ────────────────────────────────────────────

function setupIPC() {
  // MCP tool calls from renderer (direct function call, no HTTP)
  ipcMain.handle('mcp:call-tool', async (_event, toolName, args) => {
    try {
      const resultText = await handleToolCall(toolName, args);
      return {
        success: true,
        data: {
          content: [{ type: 'text', text: String(resultText) }],
          isError: false,
        },
      };
    } catch (err) {
      return {
        success: true,
        data: {
          content: [{ type: 'text', text: `工具执行异常: ${err.message}` }],
          isError: true,
        },
      };
    }
  });

  // Get tool list
  ipcMain.handle('mcp:list-tools', async () => {
    try {
      return { success: true, data: getToolList() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Health check (no port — pure IPC, no HTTP server)
  ipcMain.handle('mcp:health', async () => {
    try {
      const tools = getToolList();
      return { success: true, tools: tools.length };
    } catch {
      return { success: true, tools: 0 };
    }
  });

  // Update tool hint (called by renderer when tool registry changes)
  // Kept for backward compat, though renderer now handles request modification itself
  ipcMain.on('agent:update-tool-hint', (_event, hint) => {
    globalThis._currentToolHint = hint;
  });

  // Debug logger — writes to ~/.ds-agent/log/ds-agent.log
  const logDir = path.join(require('os').homedir(), '.ds-agent', 'log');
  const debugLogPath = path.join(logDir, 'ds-agent.log');
  ipcMain.on('debug:log', (_event, line) => {
    try {
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.appendFileSync(debugLogPath, line + '\n');
    } catch (e) { /* ignore */ }
  });

  // Open control panel
  ipcMain.handle('ui:open-control-panel', () => {
    createControlPanel();
  });

  // Workspace management
  ipcMain.handle('workspace:get', () => {
    return getWorkspace();
  });

  ipcMain.handle('workspace:set', (_event, newPath) => {
    const result = setWorkspace(newPath);
    // If successful, persist to config
    if (!result.startsWith('错误') && !result.startsWith('切换工作目录失败')) {
      const data = loadConfig();
      data.workspace = getWorkspace();
      saveConfig(data);
    }
    return result;
  });

  ipcMain.handle('workspace:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const selectedPath = result.filePaths[0];
    const setResult = setWorkspace(selectedPath);
    if (!setResult.startsWith('错误') && !setResult.startsWith('切换工作目录失败')) {
      const data = loadConfig();
      data.workspace = getWorkspace();
      saveConfig(data);
    }
    return getWorkspace();
  });

  // Navigate to a chat site
  ipcMain.handle('nav:goto', (_event, url) => {
    if (mainWindow) {
      mainWindow.loadURL(url);
    }
  });

  // Get current URL
  ipcMain.handle('nav:get-url', () => {
    return mainWindow?.webContents.getURL() || '';
  });

  // Detect which chat site is active
  ipcMain.handle('nav:detect-site', () => {
    const url = mainWindow?.webContents.getURL() || '';
    if (url.includes('chat.deepseek.com')) return 'deepseek';
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';
    return 'unknown';
  });

  // Config management — simple JSON file store (electron-store v10 is ESM-only)
  const configPath = path.join(app.getPath('userData'), 'agent-config.json');

  function loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { return {}; }
  }

  function saveConfig(data) {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  ipcMain.handle('config:get', (_event, key) => {
    return loadConfig()[key];
  });

  ipcMain.handle('config:set', (_event, key, value) => {
    const data = loadConfig();
    data[key] = value;
    saveConfig(data);
  });

  // ─── Conversation Management ──────────────────────────────
  // Conversations are stored as JSON files in {userData}/conversations/
  const conversationsDir = path.join(app.getPath('userData'), 'conversations');
  console.log(`[DS Agent] Conversations dir: ${conversationsDir}`);

  function ensureConversationsDir() {
    if (!fs.existsSync(conversationsDir)) {
      fs.mkdirSync(conversationsDir, { recursive: true });
      console.log(`[DS Agent] Created conversations dir: ${conversationsDir}`);
    }
  }

  function getConversationPath(id) {
    return path.join(conversationsDir, id + '.json');
  }

  // List all conversations (summary only, no messages)
  ipcMain.handle('conversation:list', async () => {
    const t0 = Date.now();
    try {
      ensureConversationsDir();
      const files = fs.readdirSync(conversationsDir).filter(f => f.endsWith('.json'));
      const conversations = [];
      let skipped = 0;
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(conversationsDir, file), 'utf-8'));
          conversations.push({
            id: data.id,
            title: data.title || '未命名会话',
            createdAt: data.createdAt || 0,
            updatedAt: data.updatedAt || 0,
            messageCount: (data.messages || []).length,
          });
        } catch (e) { skipped++; }
      }
      conversations.sort((a, b) => b.updatedAt - a.updatedAt);
      console.log(`[DS Agent] conversation:list → ${conversations.length} convs, ${skipped} skipped, ${Date.now() - t0}ms`);
      return { success: true, data: conversations };
    } catch (err) {
      console.error(`[DS Agent] conversation:list ERROR:`, err.message);
      return { success: false, error: err.message };
    }
  });

  // Get a specific conversation by ID
  ipcMain.handle('conversation:get', async (_event, id) => {
    const t0 = Date.now();
    try {
      ensureConversationsDir();
      const filePath = getConversationPath(id);
      if (!fs.existsSync(filePath)) {
        console.log(`[DS Agent] conversation:get ${id} → not found`);
        return { success: false, error: '会话不存在' };
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const msgCount = (data.messages || []).length;
      console.log(`[DS Agent] conversation:get ${id} → ${msgCount} msgs, ${Date.now() - t0}ms`);
      return { success: true, data };
    } catch (err) {
      console.error(`[DS Agent] conversation:get ${id} ERROR:`, err.message);
      return { success: false, error: err.message };
    }
  });

  // Save (create or update) a conversation
  ipcMain.handle('conversation:save', async (_event, conversation) => {
    const t0 = Date.now();
    try {
      ensureConversationsDir();
      if (!conversation.id) {
        return { success: false, error: '缺少会话 ID' };
      }
      const filePath = getConversationPath(conversation.id);
      const msgCount = (conversation.messages || []).length;
      const data = {
        id: conversation.id,
        title: conversation.title || '未命名会话',
        messages: conversation.messages || [],
        createdAt: conversation.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(filePath, json, 'utf-8');
      console.log(`[DS Agent] conversation:save ${conversation.id} → ${msgCount} msgs, ${json.length} bytes, ${Date.now() - t0}ms`);
      return { success: true };
    } catch (err) {
      console.error(`[DS Agent] conversation:save ${conversation.id} ERROR:`, err.message);
      return { success: false, error: err.message };
    }
  });

  // Delete a conversation
  ipcMain.handle('conversation:delete', async (_event, id) => {
    try {
      ensureConversationsDir();
      const filePath = getConversationPath(id);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[DS Agent] conversation:delete ${id} → deleted`);
      } else {
        console.log(`[DS Agent] conversation:delete ${id} → not found (no-op)`);
      }
      return { success: true };
    } catch (err) {
      console.error(`[DS Agent] conversation:delete ${id} ERROR:`, err.message);
      return { success: false, error: err.message };
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────

function getIconPath() {
  const ext = process.platform === 'win32' ? 'ico' : process.platform === 'darwin' ? 'icns' : 'png';
  const iconPath = path.join(__dirname, '..', '..', 'assets', `icon.${ext}`);
  // In packaged app, resources are in process.resourcesPath
  if (!fs.existsSync(iconPath)) {
    const packagedPath = path.join(process.resourcesPath, 'assets', `icon.${ext}`);
    if (fs.existsSync(packagedPath)) return packagedPath;
    // Fallback: try PNG which is the most universal
    const pngPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    if (fs.existsSync(pngPath)) return pngPath;
    const packagedPng = path.join(process.resourcesPath, 'assets', 'icon.png');
    if (fs.existsSync(packagedPng)) return packagedPng;
  }
  return iconPath;
}

// ─── App Lifecycle ───────────────────────────────────────────

app.whenReady().then(async () => {
  // 0. Setup session (UA, headers) BEFORE any window is created
  setupSession();

  // 1. Setup IPC (tool handlers are already loaded via require)
  setupIPC();

  // 1.5 Restore workspace from saved config
  try {
    const configPath = path.join(app.getPath('userData'), 'agent-config.json');
    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (savedConfig.workspace) {
      setWorkspace(savedConfig.workspace);
    }
  } catch { /* no config yet, use default */ }

  // 2. Create main window
  createMainWindow();

  // 3. Setup request interception
  setupRequestInterception();

  // 4. Create tray (after window is ready)
  createTray();

  console.log(`[DS Agent] Application ready — pure IPC mode, workspace: ${getWorkspace()}`);
});

app.on('window-all-closed', () => {
  if (!tray) {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  } else {
    createMainWindow();
  }
});

// Prevent navigation to unsupported URLs
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // Open external links in system browser
    if (!url.includes('chat.deepseek.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
});
