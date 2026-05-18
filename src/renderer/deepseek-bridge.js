/**
 * DeepSeek Bridge (renderer side)
 *
 * Injected into the DeepSeek chat page (MAIN WORLD) by preload.
 * Routes IPC requests from the main process into DeepSeekClient and streams
 * thinking / content increments back as IPC events.
 *
 * Protocol (matches src/main/llm-bridge.js):
 *   in   "llm:run"        { requestId, prompt, mode }
 *   in   "llm:abort"      { requestId }
 *   out  "llm:thinking"   { requestId, delta }
 *   out  "llm:content"    { requestId, delta }
 *   out  "llm:end"        { requestId }
 *   out  "llm:error"      { requestId, message }
 */

(function () {
  'use strict';

  var TAG = '[DSBridge]';

  function log(level, msg) {
    console.log(TAG + ' [' + level + '] ' + msg);
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(), tag: 'DSBridge', level: level, msg: msg
        }));
      }
    } catch (_) {}
  }

  function logError(msg, err) {
    console.error(TAG + ' [ERROR] ' + msg + (err ? ' ' + (err.message || err) : ''));
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(), tag: 'DSBridge', level: 'ERROR', msg: msg,
          error: err ? (err.message || String(err)) : undefined
        }));
      }
    } catch (_) {}
  }

  var bridge = window.dsAgent && window.dsAgent.llm;
  if (!bridge) {
    logError('window.dsAgent.llm not exposed — preload mismatch');
    return;
  }

  // ─── DeepSeekClient init (lazy: adapter may not be ready immediately) ──

  var client = null;
  var currentRequestId = null;

  function ensureAdapter() {
    if (window.__dsAgentAdapter) return window.__dsAgentAdapter;
    if (typeof window.DeepSeekAdapter !== 'function') return null;
    if (!window.__dsAgentSSECallbacks || !window.__dsAgentDOM) return null;
    try {
      window.__dsAgentAdapter = new window.DeepSeekAdapter();
      log('INFO', 'DeepSeekAdapter instantiated');
      return window.__dsAgentAdapter;
    } catch (err) {
      logError('failed to create DeepSeekAdapter', err);
      return null;
    }
  }

  function ensureClient() {
    if (client) return client;
    if (typeof window.DeepSeekClient !== 'function') return null;
    if (!ensureAdapter()) return null;
    client = new window.DeepSeekClient();
    client.onThinking(function (delta) {
      if (currentRequestId == null) return;
      try { bridge.thinking(currentRequestId, delta); } catch (_) {}
    });
    client.onContent(function (delta) {
      if (currentRequestId == null) return;
      try { bridge.content(currentRequestId, delta); } catch (_) {}
    });
    log('INFO', 'DeepSeekClient ready');
    return client;
  }

  // Try to wire the adapter as soon as the DOM looks ready, so the first
  // incoming request doesn't race with login-page loading.
  function tryEarlyInit() {
    if (window.__dsAgentAdapter) return;
    if (ensureAdapter()) return;
    // Retry on a short tick — page scripts may still be settling.
    setTimeout(tryEarlyInit, 500);
  }
  tryEarlyInit();

  // ─── Wire incoming IPC ─────────────────────────────────────────────

  bridge.onRun(function (payload) {
    var requestId = payload && payload.requestId;
    var prompt = (payload && payload.prompt) || '';
    if (typeof requestId !== 'number') return;

    // Set mode before sending the request so DeepSeekClient can read it.
    window.__dsAgentMode = (payload && payload.mode === 'quick') ? 'quick' : 'expert';

    var c = ensureClient();
    if (!c) {
      try { bridge.error(requestId, 'DeepSeekClient not initialized'); } catch (_) {}
      return;
    }

    if (currentRequestId != null) {
      try { bridge.error(requestId, 'Another request is still in flight'); } catch (_) {}
      return;
    }

    currentRequestId = requestId;
    log('INFO', 'run reqId=' + requestId + ' promptLen=' + prompt.length);

    c.sendRaw(prompt).then(function () {
      log('INFO', 'end reqId=' + requestId);
      try { bridge.end(requestId); } catch (_) {}
      if (currentRequestId === requestId) currentRequestId = null;
    }).catch(function (err) {
      logError('run failed reqId=' + requestId, err);
      try { bridge.error(requestId, err && err.message || String(err)); } catch (_) {}
      if (currentRequestId === requestId) currentRequestId = null;
    });
  });

  bridge.onAbort(function (payload) {
    var requestId = payload && payload.requestId;
    if (currentRequestId !== requestId) return;
    log('WARN', 'abort reqId=' + requestId);
    var c = client;
    if (c && c.isPending()) c.abort();
    currentRequestId = null;
  });

  log('INFO', 'DeepSeek bridge registered');
})();
