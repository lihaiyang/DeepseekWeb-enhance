/**
 * DeepSeekClient — DeepSeek 网页操作的"API 风格"封装。
 *
 * 唯一职责：把一段纯 prompt 文本注入聊天页面、等待流式响应、把 thinking /
 * content 增量回调出去。每次 sendRaw 都先点"开启新会话"，再根据当前模式
 * 确保"专家模式"或"快速模式"处于选中、"智能搜索"处于关闭，最后才注入
 * prompt，确保请求是 self-contained 的。
 *
 * Injected into the MAIN WORLD by preload.
 *
 * 依赖：
 *   window.__dsAgentAdapter   (adapter.js)
 *   window.__dsAgentDOM       (dom-bridge.js)
 *   window.__dsAgentSSECallbacks (sse-parser.js)  — 由 adapter 间接使用
 */

(function () {
  'use strict';

  var LOG_TAG = '[DSClient]';
  var STREAM_TIMEOUT_MS = 1800000; // 30 min

  function _log(level, msg) {
    console.log(LOG_TAG + ' [' + level + '] ' + msg);
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(), tag: 'DSClient', level: level, msg: msg
        }));
      }
    } catch (_) {}
  }

  function _logError(msg, err) {
    console.error(LOG_TAG + ' [ERROR] ' + msg + (err ? ' ' + (err.message || err) : ''));
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(), tag: 'DSClient', level: 'ERROR', msg: msg,
          error: err ? (err.message || String(err)) : undefined
        }));
      }
    } catch (_) {}
  }

  function DeepSeekClient() {
    this._onThinking = null;
    this._onContent = null;
    this._pending = false;
    this._requestId = 0;
    this._savedThinking = null;
    this._savedContent = null;
    this._savedEnd = null;
  }

  DeepSeekClient.prototype.onThinking = function (fn) { this._onThinking = fn; };
  DeepSeekClient.prototype.onContent  = function (fn) { this._onContent  = fn; };
  DeepSeekClient.prototype.isPending  = function ()   { return this._pending; };

  DeepSeekClient.prototype.abort = function () {
    _log('WARN', 'abort called pending=' + this._pending);
    if (this._pending) {
      var adapter = window.__dsAgentAdapter;
      if (adapter && adapter.abort) adapter.abort();
      this._restoreAdapterCallbacks();
      this._pending = false;
    }
  };

  function _clickNewChatButton() {
    return new Promise(function (resolve) {
      var clicked = false;
      var keywords = ['开启新会话', '新对话', 'New Chat', 'New chat', 'new chat'];
      var allEls = document.querySelectorAll('*');
      var candidates = [];
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        if (el.closest && el.closest('#ds-agent-panel')) continue;
        var text = (el.textContent || '').trim();
        var aria = (el.getAttribute('aria-label') || '');
        var title = (el.getAttribute('title') || '');
        var combined = text + ' ' + aria + ' ' + title;
        for (var k = 0; k < keywords.length; k++) {
          if (combined.indexOf(keywords[k]) !== -1) {
            candidates.push({ el: el, text: text });
            break;
          }
        }
      }

      if (candidates.length > 0) {
        candidates.sort(function (a, b) { return a.text.length - b.text.length; });
        var target = candidates[0].el;
        var clickable = target;
        while (clickable && clickable !== document.body) {
          var tag = clickable.tagName.toLowerCase();
          var role = clickable.getAttribute('role');
          if (tag === 'button' || tag === 'a' || role === 'button' ||
              clickable.onclick || getComputedStyle(clickable).cursor === 'pointer') {
            break;
          }
          clickable = clickable.parentElement;
        }
        if (clickable && clickable !== document.body) {
          clickable.click(); clicked = true;
          _log('INFO', 'newChat clicked via text search: ' + clickable.tagName);
        } else {
          target.click(); clicked = true;
          _log('INFO', 'newChat clicked via text span');
        }
      }

      if (!clicked) {
        var selectors = [
          '[data-testid="new_chat_button"]',
          '[class*="new-chat"]', '[class*="new_chat"]',
          '[class*="sidebar"] [class*="new"]',
          'nav button:first-of-type',
          '[role="navigation"] button:first-of-type',
          'aside button:first-of-type',
        ];
        for (var s = 0; s < selectors.length; s++) {
          try {
            var btn = document.querySelector(selectors[s]);
            if (btn) { btn.click(); clicked = true; _log('INFO', 'newChat selector: ' + selectors[s]); break; }
          } catch (_) {}
        }
      }

      if (!clicked) {
        var sidebarSelectors = ['[class*="sidebar"]', '[class*="side-bar"]', '[class*="Sidebar"]', 'aside', 'nav', '[role="navigation"]'];
        for (var ss = 0; ss < sidebarSelectors.length; ss++) {
          try {
            var sidebar = document.querySelector(sidebarSelectors[ss]);
            if (sidebar) {
              var firstBtn = sidebar.querySelector('button, [role="button"], a');
              if (firstBtn) { firstBtn.click(); clicked = true; _log('INFO', 'newChat sidebar first'); break; }
            }
          } catch (_) {}
        }
      }

      if (!clicked) _log('WARN', 'newChat: could not find new chat button');

      var waited = 0, maxWait = 5000, interval = 200;
      var timer = setInterval(function () {
        waited += interval;
        var dom = window.__dsAgentDOM;
        var input = dom && dom.findInputElement && dom.findInputElement();
        if (input || waited >= maxWait) {
          clearInterval(timer);
          _log(input ? 'INFO' : 'WARN', 'newChat ' + (input ? 'ready' : 'no-input') + ' after ' + waited + 'ms');
          resolve();
        }
      }, interval);
    });
  }

  // ─── Expert mode & web search toggles ──────────────────────
  // Each new session: make sure 专家模式 is on, 智能搜索 is off. Both
  // operations are idempotent — they detect current state first and only
  // click when a toggle is actually needed.

  function _hasActiveMarker(node) {
    var cls = (node.className || '').toString();
    var ariaP = node.getAttribute('aria-pressed');
    var ariaS = node.getAttribute('aria-selected');
    var ariaC = node.getAttribute('aria-checked');
    var dataState = node.getAttribute('data-state');
    return (
      cls.indexOf('active') !== -1 || cls.indexOf('selected') !== -1 ||
      cls.indexOf('current') !== -1 || cls.indexOf('checked') !== -1 ||
      cls.indexOf('--on') !== -1 || cls.indexOf('--enabled') !== -1 ||
      ariaP === 'true' || ariaS === 'true' || ariaC === 'true' ||
      dataState === 'on' || dataState === 'checked' || dataState === 'active'
    );
  }

  function _findLabelEl(label) {
    var allEls = document.querySelectorAll('*');
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      var text = (el.textContent || '').trim();
      if (text === label) return el;
    }
    return null;
  }

  function _selectExpertMode() {
    return new Promise(function (resolve) {
      var el = _findLabelEl('专家模式');
      if (!el) {
        _log('WARN', 'expertMode: button not found');
        resolve();
        return;
      }
      // Already selected? Walk up the ancestor chain looking for an active marker.
      var node = el;
      while (node && node !== document.body) {
        if (_hasActiveMarker(node)) {
          _log('INFO', 'expertMode: already selected');
          resolve();
          return;
        }
        node = node.parentElement;
      }
      el.click();
      _log('INFO', 'expertMode: clicked');
      // Give DeepSeek's UI a beat to rerender before we touch 智能搜索 next.
      setTimeout(resolve, 300);
    });
  }

  function _selectQuickMode() {
    return new Promise(function (resolve) {
      var el = _findLabelEl('快速模式');
      if (!el) {
        _log('WARN', 'quickMode: button not found, falling back to expert');
        resolve();
        return;
      }
      // Already selected?
      var node = el;
      while (node && node !== document.body) {
        if (_hasActiveMarker(node)) {
          _log('INFO', 'quickMode: already selected');
          resolve();
          return;
        }
        node = node.parentElement;
      }
      el.click();
      _log('INFO', 'quickMode: clicked');
      setTimeout(resolve, 300);
    });
  }

  function _disableWebSearch() {
    return new Promise(function (resolve) {
      var el = _findLabelEl('智能搜索');
      if (!el) {
        _log('WARN', 'webSearch: button not found');
        resolve();
        return;
      }
      // Walk up from the label span to the actual clickable toggle container.
      var toggle = el;
      while (toggle && toggle !== document.body) {
        var tag = toggle.tagName.toLowerCase();
        var role = toggle.getAttribute('role');
        var cls = (toggle.className || '').toString();
        if (tag === 'button' || tag === 'label' ||
            role === 'button' || role === 'switch' || role === 'checkbox' ||
            cls.indexOf('toggle') !== -1 || cls.indexOf('switch') !== -1 ||
            getComputedStyle(toggle).cursor === 'pointer') {
          break;
        }
        toggle = toggle.parentElement;
      }
      var target = (toggle && toggle !== document.body) ? toggle : el;

      // Is it currently ON? Scan target + ancestors for an active marker.
      var isOn = false;
      var node = target;
      while (node && node !== document.body) {
        if (_hasActiveMarker(node)) { isOn = true; break; }
        node = node.parentElement;
      }

      if (isOn) {
        target.click();
        _log('INFO', 'webSearch: disabled');
      } else {
        _log('INFO', 'webSearch: already off');
      }
      resolve();
    });
  }

  function _ensureModeAndNoSearch() {
    var mode = window.__dsAgentMode;
    if (mode === 'quick') return _selectQuickMode().then(_disableWebSearch);
    return _selectExpertMode().then(_disableWebSearch);
  }

  /**
   * Send a raw prompt string to DeepSeek and resolve with the full response.
   * Streams thinking / content via onThinking / onContent in the meantime.
   */
  DeepSeekClient.prototype.sendRaw = function (prompt) {
    if (this._pending) {
      _log('WARN', 'sendRaw rejected: already pending');
      return Promise.reject(new Error('已有请求正在进行中'));
    }
    var self = this;
    this._pending = true;
    this._requestId++;
    var reqId = this._requestId;
    var tStart = Date.now();

    _log('INFO', 'sendRaw reqId=' + reqId + ' promptLen=' + prompt.length);

    // Network hook may otherwise prepend a stale tool hint; clear it for the
    // duration of this request.
    var prevToolHint = window.__dsAgentToolHint;
    window.__dsAgentToolHint = '';

    var adapter = window.__dsAgentAdapter;
    if (!adapter) {
      this._pending = false;
      window.__dsAgentToolHint = prevToolHint;
      _logError('sendRaw: adapter missing');
      return Promise.reject(new Error('DeepSeek 尚未就绪，请点击终端右上角"显示 DeepSeek"按钮，登录后稍候重试。'));
    }

    this._takeoverAdapterCallbacks(adapter);

    return _clickNewChatButton().then(_ensureModeAndNoSearch).then(function () {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function settle(err, result) {
          if (settled) return;
          settled = true;
          self._restoreAdapterCallbacks();
          window.__dsAgentToolHint = prevToolHint;
          self._pending = false;
          var elapsed = Date.now() - tStart;
          if (err) { _logError('sendRaw failed reqId=' + reqId + ' elapsed=' + elapsed + 'ms', err); reject(err); }
          else     { _log('INFO', 'sendRaw done reqId=' + reqId + ' len=' + (result ? result.length : 0) + ' elapsed=' + elapsed + 'ms'); resolve(result); }
        }

        var timeout = setTimeout(function () {
          _logError('sendRaw timeout reqId=' + reqId);
          self.abort();
          settle(new Error('等待 AI 响应超时（30分钟）'));
        }, STREAM_TIMEOUT_MS);

        adapter.onEnd(function (full) { clearTimeout(timeout); settle(null, full); });

        adapter.sendMessage(prompt).then(function (full) {
          if (!settled) { clearTimeout(timeout); settle(null, full); }
        }).catch(function (err) {
          if (!settled) { clearTimeout(timeout); settle(err); }
        });
      });
    });
  };

  /**
   * Send a continuation prompt in the SAME DeepSeek chat window.
   * Skips _clickNewChatButton() — the chat session is already active.
   * Still ensures mode/search toggles are correct (idempotent checks).
   */
  DeepSeekClient.prototype.sendContinuation = function (prompt) {
    if (this._pending) {
      _log('WARN', 'sendContinuation rejected: already pending');
      return Promise.reject(new Error('已有请求正在进行中'));
    }
    var self = this;
    this._pending = true;
    this._requestId++;
    var reqId = this._requestId;
    var tStart = Date.now();

    _log('INFO', 'sendContinuation reqId=' + reqId + ' promptLen=' + prompt.length);

    var prevToolHint = window.__dsAgentToolHint;
    window.__dsAgentToolHint = '';

    var adapter = window.__dsAgentAdapter;
    if (!adapter) {
      this._pending = false;
      window.__dsAgentToolHint = prevToolHint;
      _logError('sendContinuation: adapter missing');
      return Promise.reject(new Error('DeepSeek 尚未就绪，请点击终端右上角"显示 DeepSeek"按钮，登录后稍候重试。'));
    }

    this._takeoverAdapterCallbacks(adapter);

    // No _clickNewChatButton() — reuse the active chat session.
    // _ensureModeAndNoSearch is idempotent (only clicks when needed),
    // keeping < 600ms overhead.
    return _ensureModeAndNoSearch().then(function () {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function settle(err, result) {
          if (settled) return;
          settled = true;
          self._restoreAdapterCallbacks();
          window.__dsAgentToolHint = prevToolHint;
          self._pending = false;
          var elapsed = Date.now() - tStart;
          if (err) { _logError('sendContinuation failed reqId=' + reqId + ' elapsed=' + elapsed + 'ms', err); reject(err); }
          else     { _log('INFO', 'sendContinuation done reqId=' + reqId + ' len=' + (result ? result.length : 0) + ' elapsed=' + elapsed + 'ms'); resolve(result); }
        }

        var timeout = setTimeout(function () {
          _logError('sendContinuation timeout reqId=' + reqId);
          self.abort();
          settle(new Error('等待 AI 响应超时（30分钟）'));
        }, STREAM_TIMEOUT_MS);

        adapter.onEnd(function (full) { clearTimeout(timeout); settle(null, full); });

        adapter.sendMessage(prompt).then(function (full) {
          if (!settled) { clearTimeout(timeout); settle(null, full); }
        }).catch(function (err) {
          if (!settled) { clearTimeout(timeout); settle(err); }
        });
      });
    });
  };

  DeepSeekClient.prototype._takeoverAdapterCallbacks = function (adapter) {
    this._savedThinking = adapter._thinkingCallbacks ? adapter._thinkingCallbacks.slice() : [];
    this._savedContent  = adapter._contentCallbacks  ? adapter._contentCallbacks.slice()  : [];
    this._savedEnd      = adapter._endCallbacks      ? adapter._endCallbacks.slice()      : [];

    adapter._thinkingCallbacks = [];
    adapter._contentCallbacks  = [];
    adapter._endCallbacks      = [];

    var self = this;
    if (this._onThinking) {
      adapter._thinkingCallbacks.push(function (d) { try { self._onThinking(d); } catch (_) {} });
    }
    if (this._onContent) {
      adapter._contentCallbacks.push(function (d) { try { self._onContent(d); } catch (_) {} });
    }
  };

  DeepSeekClient.prototype._restoreAdapterCallbacks = function () {
    var adapter = window.__dsAgentAdapter;
    if (!adapter) return;
    if (this._savedThinking !== null) { adapter._thinkingCallbacks = this._savedThinking; this._savedThinking = null; }
    if (this._savedContent  !== null) { adapter._contentCallbacks  = this._savedContent;  this._savedContent  = null; }
    if (this._savedEnd      !== null) { adapter._endCallbacks      = this._savedEnd;      this._savedEnd      = null; }
  };

  window.DeepSeekClient = DeepSeekClient;
  _log('INFO', 'DeepSeekClient registered');
})();
