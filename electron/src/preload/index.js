/**
 * DS Agent — Preload Script
 *
 * Exposes a safe API bridge between the renderer (chat page) and the main process.
 * This replaces all GM_* calls from the original userscript.
 *
 * Architecture:
 *  - contextBridge.exposeInMainWorld() puts window.dsAgent into the MAIN WORLD
 *  - On chat pages, we inject agent.js as a <script> tag into the page DOM,
 *    which also runs in the MAIN WORLD and can therefore access window.dsAgent
 *  - Network hooks (fetch/XHR) MUST be installed BEFORE the page's JS runs,
 *    so we inject them as early as possible via <script> tag
 *  - Control panel and other windows get the API but no agent injection
 *
 * CRITICAL: Never use document.write() in preload — it replaces the entire
 * document and causes a white screen!
 */

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// ─── Expose API to Main World ────────────────────────────────
contextBridge.exposeInMainWorld('dsAgent', {
  version: '1.0.0',

  // MCP Tool Calls (pure IPC, no HTTP server)
  callTool: (toolName, args) => ipcRenderer.invoke('mcp:call-tool', toolName, args),
  listTools: () => ipcRenderer.invoke('mcp:list-tools'),
  health: () => ipcRenderer.invoke('mcp:health'),

  // Agent Context
  updateToolHint: (hint) => ipcRenderer.send('agent:update-tool-hint', hint),

  // Navigation
  goto: (url) => ipcRenderer.invoke('nav:goto', url),
  getCurrentURL: () => ipcRenderer.invoke('nav:get-url'),
  detectSite: () => ipcRenderer.invoke('nav:detect-site'),

  // UI
  openControlPanel: () => ipcRenderer.invoke('ui:open-control-panel'),

  // Config
  getConfig: (key) => ipcRenderer.invoke('config:get', key),
  setConfig: (key, value) => ipcRenderer.invoke('config:set', key, value),

  // Events
  onToolResult: (callback) => {
    ipcRenderer.on('mcp:tool-result', (_event, result) => callback(result));
  },
  onAgentStatus: (callback) => {
    ipcRenderer.on('agent:status', (_event, status) => callback(status));
  },
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },
});

console.log('[DS Agent] Preload script loaded — window.dsAgent API available');

// ─── Detect if we're on a chat page ──────────────────────────
const CHAT_HOSTNAMES = ['chat.deepseek.com', 'chatgpt.com', 'chat.openai.com'];
const currentURL = window.location.href;
const isChatPage = CHAT_HOSTNAMES.some(h => currentURL.includes(h));

if (isChatPage) {
  // ─── Anti-Fingerprint Injection ────────────────────────────
  // Remove Electron/Chromium-specific properties that leak the app is not
  // a normal Chrome browser. This must run BEFORE any page JS.
  const antiFingerprintCode = `
(function() {
  'use strict';
  // Remove navigator.webdriver (set to undefined, not false — more natural)
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

  // Remove Electron-specific properties from navigator
  // Some sites check for these to detect Electron apps
  if (navigator.plugins) {
    // Override plugins to look like a standard Chrome install
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        // Standard Chrome has PluginArray with common plugins
        return [
          Object.create(Plugin.prototype, {
            name: { value: 'Chrome PDF Plugin' },
            filename: { value: 'internal-pdf-viewer' },
            description: { value: 'Portable Document Format' },
            length: { value: 1 },
            '0': { value: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' } }
          }),
          Object.create(Plugin.prototype, {
            name: { value: 'Chrome PDF Viewer' },
            filename: { value: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            description: { value: '' },
            length: { value: 1 },
            '0': { value: { type: 'application/pdf', suffixes: 'pdf', description: '' } }
          }),
          Object.create(Plugin.prototype, {
            name: { value: 'Native Client' },
            filename: { value: 'internal-nacl-plugin' },
            description: { value: '' },
            length: { value: 2 },
            '0': { value: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' } },
            '1': { value: { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' } }
          })
        ];
      },
      configurable: true
    });
  }

  // Override navigator.mimeTypes
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      return [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }
      ];
    },
    configurable: true
  });

  // Ensure navigator.platform matches our UA (macOS)
  // This is usually correct in Electron on macOS, but let's be safe

  // Remove any Electron-specific globals that pages might detect
  // Note: window.__dsAgent is our own API — it's not a standard Electron thing
  // so it shouldn't trigger detection

  // Fake chrome runtime (some sites check for this to detect Chrome)
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() {},
      sendMessage: function() {},
      onMessage: { addListener: function() {} }
    };
  }

  console.log('[DS Agent] Anti-fingerprint patch applied');
})();
`;

  // ─── Early Network Hook Injection ──────────────────────────
  // CRITICAL: We must hook fetch/XHR BEFORE the page's JavaScript uses them.
  // We inject a <script> tag that runs in the MAIN WORLD as early as possible.

  const earlyHookCode = `
(function() {
  'use strict';
  var PREFIX = '[DS Agent]';

  // Save originals BEFORE page JS can use them
  var _origFetch = window.fetch;
  var _origXHROpen = XMLHttpRequest.prototype.open;
  var _origXHRSend = XMLHttpRequest.prototype.send;

  // Store for tool hint — will be set by agent.js when ready
  window.__dsAgentToolHint = '';
  window.__dsAgentToolFiles = [];

  // Request body modifier
  function modifyRequestBody(bodyStr) {
    if (!bodyStr) return bodyStr;
    var hint = window.__dsAgentToolHint;
    if (!hint) return bodyStr;

    try {
      var parsed = JSON.parse(bodyStr);
      if (bodyStr.indexOf('[系统指令]') !== -1) return bodyStr;

      // DeepSeek style: { prompt: "..." }
      if (parsed.prompt && typeof parsed.prompt === 'string') {
        parsed.prompt = hint + '\\n\\n' + parsed.prompt;
        return JSON.stringify(parsed);
      }
      // ChatGPT style: { messages: [...] }
      if (parsed.messages && parsed.messages.length) {
        var hasHint = parsed.messages.some(function(m) {
          return m.role === 'system' && typeof m.content === 'string' && m.content.indexOf('[系统指令]') !== -1;
        });
        if (!hasHint) {
          parsed.messages.unshift({ role: 'system', content: hint });
          return JSON.stringify(parsed);
        }
      }
    } catch(e) { /* not JSON, return as-is */ }

    // Inject tool file context
    if (window.__dsAgentToolFiles.length > 0) {
      try {
        var parsed = JSON.parse(bodyStr);
        var ctx = '\\n\\n[上传文件内容]\\n';
        for (var i = 0; i < window.__dsAgentToolFiles.length; i++) {
          var f = window.__dsAgentToolFiles[i];
          ctx += '\\n--- ' + f.filename + ' ---\\n' + f.text + '\\n';
        }
        if (parsed.prompt && typeof parsed.prompt === 'string') {
          parsed.prompt += ctx;
        } else if (parsed.messages && parsed.messages.length) {
          var lastMsg = parsed.messages[parsed.messages.length - 1];
          if (typeof lastMsg.content === 'string') lastMsg.content += ctx;
        }
        window.__dsAgentToolFiles = [];
        return JSON.stringify(parsed);
      } catch(e) { /* ignore */ }
    }

    return bodyStr;
  }

  // SSE parser
  function parseSSEChunk(rawText) {
    var content = '';
    var lines = rawText.split('\\n');
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (!trimmed || trimmed.indexOf('data: ') !== 0) continue;
      var jsonStr = trimmed.slice(6).trim();
      if (jsonStr === '[DONE]') continue;
      try {
        var obj = JSON.parse(jsonStr);
        if (typeof obj.v === 'string' && obj.v.length > 0) {
          var p = obj.p || '';
          if (p.indexOf('fragments') === -1 && p.indexOf('status') === -1) {
            content += obj.v;
          }
          continue;
        }
        var c = obj && obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
        if (c) { content += c; continue; }
        var mc = obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content;
        if (mc) { content += mc; continue; }
      } catch(e) { /* not JSON */ }
    }
    return content;
  }

  // Will be set by agent.js when ready
  window.__dsAgentCheckToolCalls = null;
  window.__dsAgentRunLoop = null;

  // Hook fetch
  window.fetch = async function() {
    var url = (typeof arguments[0] === 'string') ? arguments[0] : (arguments[0] && arguments[0].url);
    var isCompletion = url && (url.indexOf('completion') !== -1 || url.indexOf('conversation') !== -1);

    if (isCompletion && arguments[1] && arguments[1].body) {
      try {
        arguments[1].body = modifyRequestBody(arguments[1].body);
      } catch(e) { console.error(PREFIX + ' fetch body mod error:', e); }
    }

    var response = await _origFetch.apply(this, arguments);

    if (isCompletion) {
      var clone = response.clone();
      clone.text().then(function(text) {
        var content = parseSSEChunk(text);
        if (content && window.__dsAgentCheckToolCalls) {
          var calls = window.__dsAgentCheckToolCalls(content);
          if (calls && calls.length > 0 && window.__dsAgentRunLoop) {
            console.log(PREFIX + ' Detected ' + calls.length + ' tool call(s) in fetch');
            window.__dsAgentRunLoop(calls);
          }
        }
      }).catch(function() {});
    }

    return response;
  };

  // Hook XMLHttpRequest
  var xhrMeta = new WeakMap();

  XMLHttpRequest.prototype.open = function(method, url) {
    xhrMeta.set(this, { url: url, method: method });
    return _origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    var meta = xhrMeta.get(this);
    var isCompletion = meta && meta.url && (meta.url.indexOf('completion') !== -1 || meta.url.indexOf('conversation') !== -1);

    if (isCompletion && body) {
      try {
        body = modifyRequestBody(body);
      } catch(e) { console.error(PREFIX + ' XHR body mod error:', e); }
    }

    if (isCompletion) {
      var requestContent = '';
      this.addEventListener('load', function() {
        try {
          var rt = this.responseText || '';
          if (rt) requestContent = parseSSEChunk(rt);
        } catch(e) { /* ignore */ }
        if (requestContent && window.__dsAgentCheckToolCalls) {
          var calls = window.__dsAgentCheckToolCalls(requestContent);
          if (calls && calls.length > 0 && window.__dsAgentRunLoop) {
            console.log(PREFIX + ' Detected ' + calls.length + ' tool call(s) in XHR');
            window.__dsAgentRunLoop(calls);
          }
        }
      });
    }

    return _origXHRSend.apply(this, [body]);
  };

  console.log(PREFIX + ' Network hooks installed (early injection)');
})();
`;

  // ─── Inject <script> tag into MAIN WORLD ───────────────────
  // CRITICAL: Never use document.write() — it replaces the entire document!
  //
  // In Electron's preload, document.documentElement exists as an empty <html>
  // element before page HTML starts loading. We prepend our <script> to it.
  // The script runs synchronously in the MAIN WORLD, hooking fetch/XHR before
  // the page's own JavaScript executes.

  function injectScriptToMainWorld(code, scriptId) {
    const script = document.createElement('script');
    script.textContent = code;
    script.id = scriptId;

    const target = document.documentElement;
    if (target) {
      target.prepend(script);
      // Remove the script element after execution to keep DOM clean
      // (the code has already executed synchronously)
      script.remove();
      return true;
    }
    return false;
  }

  // Inject anti-fingerprint + network hooks immediately
  // document.documentElement should exist in preload context before
  // the page HTML starts loading
  const antiFpInjected = injectScriptToMainWorld(antiFingerprintCode, 'ds-agent-antifp');
  if (antiFpInjected) {
    console.log('[DS Agent] Anti-fingerprint script injected');
  }

  const hooksInjected = injectScriptToMainWorld(earlyHookCode, 'ds-agent-hooks');
  if (hooksInjected) {
    console.log('[DS Agent] Early network hooks injected');
  } else {
    // Fallback: wait for documentElement via MutationObserver
    // This should rarely happen in Electron, but just in case
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        injectScriptToMainWorld(earlyHookCode, 'ds-agent-hooks');
        console.log('[DS Agent] Early network hooks injected (via MutationObserver)');
      }
    });
    observer.observe(document, { childList: true, subtree: false });
  }

  // ─── Inject Full Agent Script after DOM Ready ────────────────
  function injectAgentScript() {
    try {
      const agentScriptPath = path.join(__dirname, '..', 'renderer', 'agent.js');
      const agentCode = fs.readFileSync(agentScriptPath, 'utf-8');

      const existing = document.getElementById('ds-agent-injected');
      if (existing) existing.remove();

      injectScriptToMainWorld(agentCode, 'ds-agent-injected');
      console.log('[DS Agent] Agent script injected via <script> tag');
    } catch (err) {
      console.error('[DS Agent] Failed to inject agent script:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAgentScript);
  } else {
    injectAgentScript();
  }
}
