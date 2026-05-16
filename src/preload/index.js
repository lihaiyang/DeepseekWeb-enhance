/**
 * DS Agent — Preload Script (DeepSeek page)
 *
 * 只关心 DeepSeek 网页：注入反指纹、SSE 解析、DOM bridge、adapter、
 * DeepSeekClient、deepseek-bridge。所有 UI、会话存储、Prompt 管理都已迁移
 * 到 pi-coding-agent，本 preload 不再注入它们。
 */

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

contextBridge.exposeInMainWorld('dsAgent', {
  version: '2.0.0',

  // Debug logger — writes to ~/.ds-agent/log/ds-agent.log via main.
  debugLog: (line) => ipcRenderer.send('debug:log', line),

  // LLM bridge: main ↔ this page. See src/main/llm-bridge.js
  llm: {
    onRun:   (cb) => ipcRenderer.on('llm:run',   (_e, p) => cb(p)),
    onAbort: (cb) => ipcRenderer.on('llm:abort', (_e, p) => cb(p)),
    thinking: (requestId, delta) => ipcRenderer.send('llm:thinking', { requestId, delta }),
    content:  (requestId, delta) => ipcRenderer.send('llm:content',  { requestId, delta }),
    end:      (requestId)        => ipcRenderer.send('llm:end',      { requestId }),
    error:    (requestId, msg)   => ipcRenderer.send('llm:error',    { requestId, message: msg }),
  },
});

console.log('[DS Agent] Preload loaded — window.dsAgent ready');

// ─── Anti-fingerprint + Network hooks + DeepSeek bridge ──────────────────
// All run in the page's MAIN WORLD via injected <script> tags.

const ANTI_FP_CODE = `
(function () {
  'use strict';
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function () {}, sendMessage: function () {},
      onMessage: { addListener: function () {} }
    };
  }
})();
`;

const EARLY_HOOK_CODE = (
  '(function () {\n' +
  '  "use strict";\n' +
  '  if (window.__dsAgentHooksInstalled) return;\n' +
  '  window.__dsAgentHooksInstalled = true;\n' +
  '  var PREFIX = "[DS Agent]";\n' +
  '  var _origFetch = window.fetch;\n' +
  '  var _origXHROpen = XMLHttpRequest.prototype.open;\n' +
  '  var _origXHRSend = XMLHttpRequest.prototype.send;\n' +
  '  window.__dsAgentToolHint = "";\n' +
  '  window.__dsAgentOrigFetch = _origFetch;\n' +
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
  '    } catch (_) {}\n' +
  '    return bodyStr;\n' +
  '  }\n' +
  '\n' +
  '  window.fetch = async function () {\n' +
  '    var url = (typeof arguments[0] === "string") ? arguments[0] : (arguments[0] && arguments[0].url);\n' +
  '    var isCompletion = url && (url.indexOf("completion") !== -1 || url.indexOf("conversation") !== -1);\n' +
  '    if (isCompletion && arguments[1] && arguments[1].body) {\n' +
  '      try { arguments[1].body = modifyRequestBody(arguments[1].body); } catch (_) {}\n' +
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
  '        reader.read().then(function (result) {\n' +
  '          if (result.done) {\n' +
  '            if (buffer.trim()) {\n' +
  '              var lines = buffer.split("\\n");\n' +
  '              for (var i = 0; i < lines.length; i++) window.__dsAgentProcessLine(lines[i], thinkingAcc, responseAcc, pTracker);\n' +
  '            }\n' +
  '            lastLens = window.__dsAgentFireCallbacks(thinkingAcc, responseAcc, true, lastLens.thinkingLen, lastLens.responseLen, pTracker);\n' +
  '            return;\n' +
  '          }\n' +
  '          var chunk = decoder.decode(result.value, { stream: true });\n' +
  '          buffer += chunk;\n' +
  '          var idx;\n' +
  '          while ((idx = buffer.indexOf("\\n\\n")) !== -1) {\n' +
  '            var eventText = buffer.substring(0, idx);\n' +
  '            buffer = buffer.substring(idx + 2);\n' +
  '            if (eventText.trim()) {\n' +
  '              var lines2 = eventText.split("\\n");\n' +
  '              for (var j = 0; j < lines2.length; j++) window.__dsAgentProcessLine(lines2[j], thinkingAcc, responseAcc, pTracker);\n' +
  '            }\n' +
  '          }\n' +
  '          lastLens = window.__dsAgentFireCallbacks(thinkingAcc, responseAcc, false, lastLens.thinkingLen, lastLens.responseLen, pTracker);\n' +
  '          pump();\n' +
  '        }).catch(function (err) {\n' +
  '          console.error(PREFIX + " stream err:", err);\n' +
  '          lastLens = window.__dsAgentFireCallbacks(thinkingAcc, responseAcc, true, lastLens.thinkingLen, lastLens.responseLen, pTracker);\n' +
  '        });\n' +
  '      }\n' +
  '      pump();\n' +
  '    }\n' +
  '    return response;\n' +
  '  };\n' +
  '\n' +
  '  var xhrMeta = new WeakMap();\n' +
  '  XMLHttpRequest.prototype.open = function (method, url) {\n' +
  '    xhrMeta.set(this, { url: url, method: method });\n' +
  '    return _origXHROpen.apply(this, arguments);\n' +
  '  };\n' +
  '  XMLHttpRequest.prototype.send = function (body) {\n' +
  '    var meta = xhrMeta.get(this);\n' +
  '    var isCompletion = meta && meta.url && (meta.url.indexOf("completion") !== -1 || meta.url.indexOf("conversation") !== -1);\n' +
  '    if (isCompletion && body) {\n' +
  '      try { body = modifyRequestBody(body); } catch (_) {}\n' +
  '    }\n' +
  '    if (isCompletion) {\n' +
  '      var thinkingAcc = { val: "" };\n' +
  '      var responseAcc = { val: "" };\n' +
  '      var lastProcessedLen = 0;\n' +
  '      var lastLens = { thinkingLen: 0, responseLen: 0 };\n' +
  '      var xhrBuffer = "";\n' +
  '      var xhrPTracker = {};\n' +
  '      this.addEventListener("readystatechange", function () {\n' +
  '        try {\n' +
  '          if (this.readyState === 3 || this.readyState === 4) {\n' +
  '            var rt = this.responseText || "";\n' +
  '            var newText = rt.substring(lastProcessedLen);\n' +
  '            lastProcessedLen = rt.length;\n' +
  '            xhrBuffer += newText;\n' +
  '            var idx;\n' +
  '            while ((idx = xhrBuffer.indexOf("\\n\\n")) !== -1) {\n' +
  '              var eventText = xhrBuffer.substring(0, idx);\n' +
  '              xhrBuffer = xhrBuffer.substring(idx + 2);\n' +
  '              if (eventText.trim()) {\n' +
  '                var lines = eventText.split("\\n");\n' +
  '                for (var i = 0; i < lines.length; i++) window.__dsAgentProcessLine(lines[i], thinkingAcc, responseAcc, xhrPTracker);\n' +
  '              }\n' +
  '            }\n' +
  '            if (this.readyState === 4 && xhrBuffer.trim()) {\n' +
  '              var lines = xhrBuffer.split("\\n");\n' +
  '              for (var k = 0; k < lines.length; k++) window.__dsAgentProcessLine(lines[k], thinkingAcc, responseAcc, xhrPTracker);\n' +
  '              xhrBuffer = "";\n' +
  '            }\n' +
  '            lastLens = window.__dsAgentFireCallbacks(thinkingAcc, responseAcc, this.readyState === 4, lastLens.thinkingLen, lastLens.responseLen, xhrPTracker);\n' +
  '          }\n' +
  '        } catch (e) { console.error(PREFIX + " XHR err:", e); }\n' +
  '      });\n' +
  '    }\n' +
  '    return _origXHRSend.apply(this, [body]);\n' +
  '  };\n' +
  '})();'
);

function injectScriptToMainWorld(code, scriptId) {
  const script = document.createElement('script');
  script.textContent = code;
  script.id = scriptId;
  const target = document.documentElement;
  if (!target) return false;
  target.prepend(script);
  script.remove();
  return true;
}

function readModule(relativePath) {
  try {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf-8');
  } catch (err) {
    console.error('[DS Agent] Failed to read ' + relativePath + ':', err);
    return '';
  }
}

const sseParserCode    = readModule('renderer/deepseek/sse-parser.js');
const domBridgeCode    = readModule('renderer/deepseek/dom-bridge.js');
const adapterCode      = readModule('renderer/deepseek/adapter.js');
const deepseekClientCode = readModule('renderer/api/DeepSeekClient.js');
const dsBridgeCode     = readModule('renderer/deepseek-bridge.js');

// 1. Inject anti-fingerprint + sse parser + early network hooks ASAP
let injectedEarly = false;
function injectEarly() {
  if (injectedEarly) return true;
  if (!document.documentElement) return false;
  injectScriptToMainWorld(ANTI_FP_CODE,    'ds-agent-antifp');
  if (sseParserCode) injectScriptToMainWorld(sseParserCode, 'ds-agent-sse-parser');
  injectScriptToMainWorld(EARLY_HOOK_CODE, 'ds-agent-hooks');
  injectedEarly = true;
  console.log('[DS Agent] Early injection complete');
  return true;
}

if (!injectEarly()) {
  const obs = new MutationObserver(() => {
    if (injectEarly()) obs.disconnect();
  });
  obs.observe(document, { childList: true, subtree: false });
}

// 2. Inject DOM bridge + adapter + DeepSeekClient + bridge after DOM ready
function injectRuntimeChain() {
  if (domBridgeCode)      injectScriptToMainWorld(domBridgeCode,      'ds-agent-dom-bridge');
  if (adapterCode)        injectScriptToMainWorld(adapterCode,        'ds-agent-adapter');
  if (deepseekClientCode) injectScriptToMainWorld(deepseekClientCode, 'ds-agent-deepseek-client');
  if (dsBridgeCode)       injectScriptToMainWorld(dsBridgeCode,       'ds-agent-bridge');
  console.log('[DS Agent] Runtime chain injected');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectRuntimeChain);
} else {
  injectRuntimeChain();
}
