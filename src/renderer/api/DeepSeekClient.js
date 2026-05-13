/**
 * DeepSeekClient — 模拟 API 调用（复用 DOM 注入 + SSE 拦截）
 *
 * Injected into the MAIN WORLD by preload.
 *
 * 不直接调 DeepSeek 后端 API，而是把现有的 DOM 注入发送 + 网络钩子拦截 SSE
 * 这套机制封装成"API 风格"：
 *   - 每次 send() 把完整上下文（system prompt + 全部历史消息）拼成一条消息
 *   - 通过 adapter（DOM 注入）发送到 DeepSeek 输入框
 *   - 网络钩子拦截 SSE 响应，adapter 触发回调
 *   - DeepSeekClient 临时接管 adapter 回调，请求完成后恢复
 *
 * 这样每个"API 调用"都是自包含的，不依赖 DeepSeek 服务端的会话状态。
 */

(function () {
  'use strict';

  var LOG_TAG = '[DSClient]';
  var STREAM_TIMEOUT_MS = 1800000;

  // ─── File Logger ────────────────────────────────────────────

  function _log(level, msg) {
    console.log(LOG_TAG + ' [' + level + '] ' + msg);
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(),
          tag: 'DSClient',
          level: level,
          msg: msg
        }));
      }
    } catch (e) { /* dsAgent not ready yet */ }
  }

  function _logError(msg, err) {
    console.error(LOG_TAG + ' [ERROR] ' + msg + (err ? ' ' + (err.message || err) : ''));
    try {
      if (window.dsAgent && window.dsAgent.debugLog) {
        window.dsAgent.debugLog(JSON.stringify({
          t: Date.now(),
          tag: 'DSClient',
          level: 'ERROR',
          msg: msg,
          error: err ? (err.message || String(err)) : undefined
        }));
      }
    } catch (e) {}
  }

  // ─── Constructor ────────────────────────────────────────────

  function DeepSeekClient() {
    this._onThinking = null;
    this._onContent = null;
    this._onEnd = null;
    this._pending = false;
    this._requestId = 0;
    // Saved adapter callbacks (restored after each request)
    this._savedThinking = null;
    this._savedContent = null;
    this._savedEnd = null;
  }

  DeepSeekClient.prototype.onThinking = function (fn) { this._onThinking = fn; };
  DeepSeekClient.prototype.onContent = function (fn) { this._onContent = fn; };
  DeepSeekClient.prototype.onEnd = function (fn) { this._onEnd = fn; };
  DeepSeekClient.prototype.isPending = function () { return this._pending; };

  DeepSeekClient.prototype.abort = function () {
    _log('WARN', 'abort called pending=' + this._pending);
    if (this._pending) {
      // Abort the adapter's pending operation
      var adapter = window.__dsAgentAdapter;
      if (adapter && adapter.abort) {
        adapter.abort();
      }
      this._restoreAdapterCallbacks();
      this._pending = false;
    }
  };

  // ─── Send (API-style) ───────────────────────────────────────

  /**
   * 点击 DeepSeek 的"开启新会话"按钮，确保每次请求从干净会话开始。
   * 复用 agent.js 中的多策略查找逻辑。
   * @returns {Promise<void>}
   */
  function _clickNewChatButton() {
    return new Promise(function (resolve) {
      var clicked = false;

      // Strategy 1: search for "开启新会话" / "New Chat" text
      var keywords = ['开启新会话', '新对话', 'New Chat', 'New chat', 'new chat'];
      var allEls = document.querySelectorAll('*');
      var candidates = [];
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        if (el.closest('#ds-agent-panel')) continue;
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
          clickable.click();
          clicked = true;
          _log('INFO', 'newChat clicked via text search: ' + clickable.tagName);
        } else {
          target.click();
          clicked = true;
          _log('INFO', 'newChat clicked via text span');
        }
      }

      // Strategy 2: try common selectors
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
            if (btn) {
              btn.click();
              clicked = true;
              _log('INFO', 'newChat clicked via selector: ' + selectors[s]);
              break;
            }
          } catch (e) {}
        }
      }

      // Strategy 3: find sidebar, click first button
      if (!clicked) {
        var sidebarSelectors = [
          '[class*="sidebar"]', '[class*="side-bar"]', '[class*="Sidebar"]',
          'aside', 'nav', '[role="navigation"]',
        ];
        for (var ss = 0; ss < sidebarSelectors.length; ss++) {
          try {
            var sidebar = document.querySelector(sidebarSelectors[ss]);
            if (sidebar) {
              var firstBtn = sidebar.querySelector('button, [role="button"], a');
              if (firstBtn) {
                firstBtn.click();
                clicked = true;
                _log('INFO', 'newChat clicked via sidebar first button');
                break;
              }
            }
          } catch (e) {}
        }
      }

      if (!clicked) {
        _log('WARN', 'newChat: could not find new chat button');
      }

      // Wait for the new conversation input to appear (up to 5s)
      var waited = 0;
      var maxWait = 5000;
      var interval = 200;
      var timer = setInterval(function () {
        waited += interval;
        var dom = window.__dsAgentDOM;
        var input = dom && dom.findInputElement && dom.findInputElement();
        if (input || waited >= maxWait) {
          clearInterval(timer);
          if (input) {
            _log('INFO', 'newChat ready after ' + waited + 'ms');
          } else {
            _log('WARN', 'newChat input not found after ' + waited + 'ms, proceeding anyway');
          }
          resolve();
        }
      }, interval);
    });
  }

  /**
   * 发送完整上下文到 DeepSeek，返回 AI 响应。
   *
   * 把 messages 数组 + systemPrompt 拼成一条完整消息，通过 DOM 注入发送。
   * 每个请求自包含，不依赖 DeepSeek 服务端会话状态。
   *
   * @param {Array<{role:string, content:string}>} messages - 完整消息历史
   * @param {string} systemPrompt - 系统提示词（工具列表等）
   * @returns {Promise<string>} AI 完整响应文本
   */
  DeepSeekClient.prototype.send = function (messages, systemPrompt) {
    if (this._pending) {
      _log('WARN', 'send rejected: already pending');
      return Promise.reject(new Error('已有请求正在进行中'));
    }

    var self = this;
    this._pending = true;
    this._requestId++;
    var reqId = this._requestId;
    var tStart = Date.now();

    // ── 1. 拼完整 prompt ──
    var prompt = '';
    if (systemPrompt) {
      prompt += systemPrompt + '\n\n';
    }
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      switch (msg.role) {
        case 'system':
          prompt += '[系统]\n' + msg.content + '\n\n';
          break;
        case 'user':
          prompt += '[用户]\n' + msg.content + '\n\n';
          break;
        case 'assistant':
          prompt += '[助手]\n' + msg.content + '\n\n';
          break;
        case 'tool':
          prompt += msg.content + '\n\n';
          break;
        default:
          prompt += '[' + msg.role + ']\n' + msg.content + '\n\n';
          break;
      }
    }

    _log('INFO', 'send reqId=' + reqId + ' msgs=' + messages.length + ' promptLen=' + prompt.length);

    // ── 2. 清掉 __dsAgentToolHint，防止网络钩子重复注入系统提示词 ──
    var prevToolHint = window.__dsAgentToolHint;
    window.__dsAgentToolHint = '';

    // ── 3. 获取 adapter ──
    var adapter = window.__dsAgentAdapter;
    if (!adapter) {
      this._pending = false;
      window.__dsAgentToolHint = prevToolHint;
      _logError('send failed: adapter not available');
      return Promise.reject(new Error('DeepSeek Adapter 未初始化'));
    }

    // ── 4. 接管 adapter 回调 ──
    this._takeoverAdapterCallbacks(adapter);

    // ── 5. 点击"开启新会话" + 发送并等待响应 ──
    return _clickNewChatButton().then(function () {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function settle(err, result) {
          if (settled) return;
          settled = true;
          self._restoreAdapterCallbacks();
          window.__dsAgentToolHint = prevToolHint;
          self._pending = false;
          var elapsed = Date.now() - tStart;
          if (err) {
            _logError('send failed reqId=' + reqId + ' elapsed=' + elapsed + 'ms', err);
            reject(err);
          } else {
            _log('INFO', 'send done reqId=' + reqId + ' responseLen=' + (result ? result.length : 0) + ' elapsed=' + elapsed + 'ms');
            resolve(result);
          }
        }

        var timeout = setTimeout(function () {
          _logError('send timeout reqId=' + reqId + ' after ' + STREAM_TIMEOUT_MS + 'ms');
          self.abort();
          settle(new Error('等待 AI 响应超时（30分钟）'));
        }, STREAM_TIMEOUT_MS);

        adapter.onEnd(function (fullResponse) {
          clearTimeout(timeout);
          settle(null, fullResponse);
        });

        _log('INFO', 'adapter.sendMessage start reqId=' + reqId);
        adapter.sendMessage(prompt).then(function (fullResponse) {
          if (!settled) {
            clearTimeout(timeout);
            settle(null, fullResponse);
          }
        }).catch(function (err) {
          if (!settled) {
            clearTimeout(timeout);
            settle(err);
          }
        });
      });
    });
  };

  // ─── Adapter Callback Takeover ──────────────────────────────

  /**
   * 保存 adapter 当前回调，替换为 DeepSeekClient 的回调。
   * 请求完成后调用 _restoreAdapterCallbacks 恢复。
   */
  DeepSeekClient.prototype._takeoverAdapterCallbacks = function (adapter) {
    // 保存原始回调数组
    this._savedThinking = adapter._thinkingCallbacks ? adapter._thinkingCallbacks.slice() : [];
    this._savedContent = adapter._contentCallbacks ? adapter._contentCallbacks.slice() : [];
    this._savedEnd = adapter._endCallbacks ? adapter._endCallbacks.slice() : [];

    // 清空并设置我们的回调
    adapter._thinkingCallbacks = [];
    adapter._contentCallbacks = [];
    adapter._endCallbacks = [];

    var self = this;
    if (this._onThinking) {
      adapter._thinkingCallbacks.push(function (delta) {
        try { self._onThinking(delta); } catch (e) {}
      });
    }
    if (this._onContent) {
      adapter._contentCallbacks.push(function (delta) {
        try { self._onContent(delta); } catch (e) {}
      });
    }
    // onEnd 由 send() 内部动态注册，这里不设置
  };

  /**
   * 恢复 adapter 的原始回调。
   */
  DeepSeekClient.prototype._restoreAdapterCallbacks = function () {
    var adapter = window.__dsAgentAdapter;
    if (!adapter) return;

    if (this._savedThinking !== null) {
      adapter._thinkingCallbacks = this._savedThinking;
      this._savedThinking = null;
    }
    if (this._savedContent !== null) {
      adapter._contentCallbacks = this._savedContent;
      this._savedContent = null;
    }
    if (this._savedEnd !== null) {
      adapter._endCallbacks = this._savedEnd;
      this._savedEnd = null;
    }
  };

  // Export
  window.DeepSeekClient = DeepSeekClient;
  _log('INFO', 'DeepSeekClient registered');
})();
