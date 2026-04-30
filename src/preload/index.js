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

  // Workspace
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  setWorkspace: (path) => ipcRenderer.invoke('workspace:set', path),
  selectFolder: () => ipcRenderer.invoke('workspace:select-folder'),

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
const CHAT_HOSTNAMES = ['chat.deepseek.com'];
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

  // ─── Core SSE processing (preload-side, serialized into main world via .toString()) ──

  function _processSSELine(line, thinkingAcc, responseAcc, pTracker) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('data:') !== 0) return;
    var jsonStr = trimmed.slice(trimmed.indexOf('data:') + 5).trim();
    if (!jsonStr || jsonStr === '[DONE]') return;
    try {
      var obj = JSON.parse(jsonStr);
      if (obj.p !== undefined && pTracker) { pTracker[obj.p] = (pTracker[obj.p] || 0) + 1; }
      if (typeof obj.thinking === 'string' && obj.thinking.length > 0) { thinkingAcc.val += obj.thinking; }
      if (obj.type === 'thinking' && typeof obj.content === 'string' && obj.content.length > 0) { thinkingAcc.val += obj.content; }
      if (obj.choices && obj.choices[0] && obj.choices[0].delta) {
        var d = obj.choices[0].delta;
        if (typeof d.reasoning_content === 'string' && d.reasoning_content.length > 0) { thinkingAcc.val += d.reasoning_content; }
        if (typeof d.content === 'string' && d.content.length > 0) { responseAcc.val += d.content; }
      }
      if (typeof obj.v === 'string' && obj.v.length > 0) {
        var p = (obj.p || '').toLowerCase();
        if (p.indexOf('status') !== -1) return;
        if (p.indexOf('think') !== -1 || p.indexOf('reason') !== -1) { thinkingAcc.val += obj.v; }
        else { responseAcc.val += obj.v; }
      }
    } catch(e) {}
  }

  function _fireStreamCallbacks(thinkingAcc, responseAcc, isFinal, lastThinkingLen, lastResponseLen) {
    lastThinkingLen = lastThinkingLen || 0;
    lastResponseLen = lastResponseLen || 0;
    var thinkingDelta = thinkingAcc.val.substring(lastThinkingLen);
    var responseDelta = responseAcc.val.substring(lastResponseLen);
    if (thinkingDelta && typeof window.__dsAgentOnThinking === 'function') { window.__dsAgentOnThinking(thinkingDelta); }
    if (responseDelta && typeof window.__dsAgentOnStreamContent === 'function') { window.__dsAgentOnStreamContent(responseDelta); }
    if (isFinal && responseAcc.val && typeof window.__dsAgentCheckToolCalls === 'function') {
      var calls = window.__dsAgentCheckToolCalls(responseAcc.val);
      if (calls && calls.length > 0 && typeof window.__dsAgentRunLoop === 'function') {
        console.log('[DS Agent] Detected ' + calls.length + ' tool call(s)');
        window.__dsAgentRunLoop(calls);
      }
    }
    return { thinkingLen: thinkingAcc.val.length, responseLen: responseAcc.val.length };
  }

  // Build injected script from preload functions + glue code.
  // Using .toString() avoids a fragile 250-line template literal.
  const earlyHookCode =
    'window.__dsAgentProcessLine = ' + _processSSELine.toString() + ';\n' +
    'window.__dsAgentFireCallbacks = ' + _fireStreamCallbacks.toString() + ';\n' +
    '(function() {\n' +
    '  "use strict";\n' +
    '  var PREFIX = "[DS Agent]";\n' +
    '  var _origFetch = window.fetch;\n' +
    '  var _origXHROpen = XMLHttpRequest.prototype.open;\n' +
    '  var _origXHRSend = XMLHttpRequest.prototype.send;\n' +
    '  window.__dsAgentToolHint = "";\n' +
    '  window.__dsAgentToolFiles = [];\n' +
    '\n' +
    '  function modifyRequestBody(bodyStr) {\n' +
    '    if (!bodyStr) return bodyStr;\n' +
    '    var hint = window.__dsAgentToolHint;\n' +
    '    if (!hint) return bodyStr;\n' +
    '    try {\n' +
    '      var parsed = JSON.parse(bodyStr);\n' +
    '      if (bodyStr.indexOf("[系统指令]") !== -1) return bodyStr;\n' +
    '      if (parsed.prompt && typeof parsed.prompt === "string") {\n' +
    '        parsed.prompt = hint + "\\n\\n" + parsed.prompt;\n' +
    '        return JSON.stringify(parsed);\n' +
    '      }\n' +
    '    } catch(e) {}\n' +
    '    return bodyStr;\n' +
    '  }\n' +
    '\n' +
    '  window.fetch = async function() {\n' +
    '    var url = (typeof arguments[0] === "string") ? arguments[0] : (arguments[0] && arguments[0].url);\n' +
    '    var isCompletion = url && (url.indexOf("completion") !== -1 || url.indexOf("conversation") !== -1);\n' +
    '    if (isCompletion && arguments[1] && arguments[1].body) {\n' +
    '      try { arguments[1].body = modifyRequestBody(arguments[1].body); } catch(e) {}\n' +
    '    }\n' +
    '    var response = await _origFetch.apply(this, arguments);\n' +
    '    if (isCompletion && response.body) {\n' +
    '      var clone = response.clone();\n' +
    '      var reader = clone.body.getReader();\n' +
    '      var decoder = new TextDecoder("utf-8");\n' +
    '      var buffer = "";\n' +
    '      var thinkingAcc = { val: "" };\n' +
    '      var responseAcc = { val: "" };\n' +
    '      var pTracker = {};\n' +
    '      var lastLens = { thinkingLen: 0, responseLen: 0 };\n' +
    '      function pump() {\n' +
    '        reader.read().then(function(result) {\n' +
    '          if (result.done) {\n' +
    '            if (buffer.trim()) {\n' +
    '              var lines = buffer.split("\\n");\n' +
    '              for (var i = 0; i < lines.length; i++) { window.__dsAgentProcessLine(lines[i], thinkingAcc, responseAcc, pTracker); }\n' +
    '            }\n' +
    '            lastLens = window.__dsAgentFireCallbacks(thinkingAcc, responseAcc, true, lastLens.thinkingLen, lastLens.responseLen);\n' +
    '            var pKeys = Object.keys(pTracker).filter(function(k) { return k !== "undefined"; });\n' +
    '            if (pKeys.length > 0) { console.log(PREFIX + " SSE p-values:", JSON.stringify(pKeys), JSON.stringify(pTracker)); }\n' +
    '            return;\n' +
    '          }\n' +
    '          var chunk = decoder.decode(result.value, { stream: true });\n' +
    '          buffer += chunk;\n' +
    '          var idx;\n' +
    '          while ((idx = buffer.indexOf("\\n\\n")) !== -1) {\n' +
    '            var eventText = buffer.substring(0, idx);\n' +
    '            buffer = buffer.substring(idx + 2);\n' +
    '            if (eventText.trim()) {\n' +
    '              var lines = eventText.split("\\n");\n' +
    '              for (var i = 0; i < lines.length; i++) { window.__dsAgentProcessLine(lines[i], thinkingAcc, responseAcc, pTracker); }\n' +
    '            }\n' +
    '          }\n' +
    '          lastLens = window.__dsAgentFireCallbacks(thinkingAcc, responseAcc, false, lastLens.thinkingLen, lastLens.responseLen);\n' +
    '          pump();\n' +
    '        }).catch(function(err) {\n' +
    '          console.error(PREFIX + " Stream error:", err);\n' +
    '          lastLens = window.__dsAgentFireCallbacks(thinkingAcc, responseAcc, true, lastLens.thinkingLen, lastLens.responseLen);\n' +
    '        });\n' +
    '      }\n' +
    '      pump();\n' +
    '    }\n' +
    '    return response;\n' +
    '  };\n' +
    '\n' +
    '  var xhrMeta = new WeakMap();\n' +
    '  XMLHttpRequest.prototype.open = function(method, url) {\n' +
    '    xhrMeta.set(this, { url: url, method: method });\n' +
    '    return _origXHROpen.apply(this, arguments);\n' +
    '  };\n' +
    '  XMLHttpRequest.prototype.send = function(body) {\n' +
    '    var meta = xhrMeta.get(this);\n' +
    '    var isCompletion = meta && meta.url && (meta.url.indexOf("completion") !== -1 || meta.url.indexOf("conversation") !== -1);\n' +
    '    if (isCompletion && body) {\n' +
    '      try { body = modifyRequestBody(body); } catch(e) {}\n' +
    '    }\n' +
    '    if (isCompletion) {\n' +
    '      var thinkingAcc = { val: "" };\n' +
    '      var responseAcc = { val: "" };\n' +
    '      var lastProcessedLen = 0;\n' +
    '      var lastLens = { thinkingLen: 0, responseLen: 0 };\n' +
    '      this.addEventListener("readystatechange", function() {\n' +
    '        try {\n' +
    '          if (this.readyState === 3 || this.readyState === 4) {\n' +
    '            var rt = this.responseText || "";\n' +
    '            var newText = rt.substring(lastProcessedLen);\n' +
    '            lastProcessedLen = rt.length;\n' +
    '            if (newText) {\n' +
    '              var lines = newText.split("\\n");\n' +
    '              for (var i = 0; i < lines.length; i++) { window.__dsAgentProcessLine(lines[i], thinkingAcc, responseAcc, null); }\n' +
    '              lastLens = window.__dsAgentFireCallbacks(thinkingAcc, responseAcc, this.readyState === 4, lastLens.thinkingLen, lastLens.responseLen);\n' +
    '            } else if (this.readyState === 4) {\n' +
    '              window.__dsAgentFireCallbacks(thinkingAcc, responseAcc, true, lastLens.thinkingLen, lastLens.responseLen);\n' +
    '            }\n' +
    '          }\n' +
    '        } catch(e) {}\n' +
    '      });\n' +
    '    }\n' +
    '    return _origXHRSend.apply(this, [body]);\n' +
    '  };\n' +
    '\n' +
    '  console.log(PREFIX + " Network hooks installed (early injection)");\n' +
    '})();\n' +
    '';

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
