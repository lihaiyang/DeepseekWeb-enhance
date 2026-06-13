/**
 * DeepSeek Adapter
 *
 * Injected into the MAIN WORLD by preload.
 * Unified interface for interacting with the DeepSeek chat page.
 *
 * Responsibilities:
 *  - sendMessage(text) → Promise<fullResponse>: inject text and wait for AI reply
 *  - onThinking(fn) / onContent(fn) / onEnd(fn): register streaming callbacks
 *  - abort(): cancel any pending sendMessage
 *  - isReady(): check if DeepSeek DOM is available
 *  - destroy(): clean up all callbacks and state
 *
 * Internally delegates to:
 *  - __dsAgentDOM (dom-bridge.js) for DOM manipulation
 *  - __dsAgentSSECallbacks (sse-parser.js) for SSE stream events
 */

(function () {
  'use strict';

  var PREFIX = '[DS Agent]';
  var STREAM_TIMEOUT_MS = 1800000; // 30 minutes

  /**
   * @constructor
   */
  function DeepSeekAdapter() {
    this._thinkingCallbacks = [];
    this._contentCallbacks = [];
    this._endCallbacks = [];
    this._pendingResolve = null;
    this._pendingReject = null;
    this._pendingTimeout = null;

    // Register with SSE parser so it calls us back
    var self = this;
    window.__dsAgentSSECallbacks.onThinking = function (delta) {
      for (var i = 0; i < self._thinkingCallbacks.length; i++) {
        self._thinkingCallbacks[i](delta);
      }
    };
    window.__dsAgentSSECallbacks.onContent = function (delta) {
      for (var i = 0; i < self._contentCallbacks.length; i++) {
        self._contentCallbacks[i](delta);
      }
    };
    window.__dsAgentSSECallbacks.onEnd = function (fullResponse) {
      for (var i = 0; i < self._endCallbacks.length; i++) {
        self._endCallbacks[i](fullResponse);
      }
      // Resolve pending sendMessage promise
      if (self._pendingResolve) {
        var resolve = self._pendingResolve;
        self._clearPending();
        resolve(fullResponse);
      }
    };
  }

  // ─── Callback Registration ──────────────────────────────────

  DeepSeekAdapter.prototype.onThinking = function (fn) {
    this._thinkingCallbacks.push(fn);
  };

  DeepSeekAdapter.prototype.onContent = function (fn) {
    this._contentCallbacks.push(fn);
  };

  DeepSeekAdapter.prototype.onEnd = function (fn) {
    this._endCallbacks.push(fn);
  };

  // ─── Status ─────────────────────────────────────────────────

  DeepSeekAdapter.prototype.isReady = function () {
    var dom = window.__dsAgentDOM;
    return !!(dom && dom.findInputElement());
  };

  // ─── Send Message ───────────────────────────────────────────

  /**
   * Inject text into the DeepSeek chat input and send it.
   * Returns a Promise that resolves with the full AI response text
   * when the SSE stream completes.
   *
   * @param {string} text - The text to send
   * @returns {Promise<string>} Full AI response
   */
  DeepSeekAdapter.prototype.sendMessage = function (text) {
    var dom = window.__dsAgentDOM;
    if (!dom) return Promise.reject(new Error('DOM bridge 未加载'));

    var input = dom.findInputElement();
    if (!input) return Promise.reject(new Error('无法找到 DeepSeek 输入框'));

    var self = this;

    return new Promise(function (resolve, reject) {
      self._pendingResolve = resolve;
      self._pendingReject = reject;

      // Safety timeout
      self._pendingTimeout = setTimeout(function () {
        if (self._pendingResolve) {
          self._clearPending();
          reject(new Error('等待 AI 响应超时（30分钟）'));
        }
      }, STREAM_TIMEOUT_MS);

      // Inject text and click send
      dom.sleep(0).then(function () {
        input.focus();
        return dom.sleep(200);
      }).then(function () {
        dom.setInputValue(input, text);
        return dom.sleep(300);
      }).then(function () {
        var sendBtn = dom.findSendButton();
        if (sendBtn) {
          sendBtn.click();
          console.log(PREFIX + ' Message sent via button click');
        } else {
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true,
          }));
          console.log(PREFIX + ' Message sent via Enter key');
        }
      }).catch(function (err) {
        self._clearPending();
        reject(err);
      });
    });
  };

  // ─── Abort ──────────────────────────────────────────────────

  /**
   * Cancel any pending sendMessage operation.
   */
  DeepSeekAdapter.prototype.abort = function () {
    if (this._pendingReject) {
      this._pendingReject(new Error('操作已取消'));
    }
    this._clearPending();
  };

  // ─── Destroy ────────────────────────────────────────────────

  DeepSeekAdapter.prototype.destroy = function () {
    this.abort();
    window.__dsAgentSSECallbacks.onThinking = null;
    window.__dsAgentSSECallbacks.onContent = null;
    window.__dsAgentSSECallbacks.onEnd = null;
    this._thinkingCallbacks = [];
    this._contentCallbacks = [];
    this._endCallbacks = [];
  };

  // ─── Internal ───────────────────────────────────────────────

  DeepSeekAdapter.prototype._clearPending = function () {
    this._pendingResolve = null;
    this._pendingReject = null;
    if (this._pendingTimeout) {
      clearTimeout(this._pendingTimeout);
      this._pendingTimeout = null;
    }
  };

  // ─── Export ─────────────────────────────────────────────────

  window.DeepSeekAdapter = DeepSeekAdapter;
  console.log('[DS Agent] DeepSeekAdapter registered');
})();
