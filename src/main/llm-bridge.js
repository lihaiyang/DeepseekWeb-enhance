'use strict';

/**
 * LlmBridge — main 进程一侧的 LLM 调用调度器
 *
 * 负责：
 *  - 把 OpenAI 兼容的请求体翻成 DeepSeek prompt
 *  - 把请求 dispatch 到 DeepSeek webview（main world 里的 DeepSeekClient）
 *  - 串行队列：DeepSeek 页面同时只能有一个 in-flight 请求
 *  - 接收 renderer 回来的 thinking/content 增量，喂给 stream translator
 *  - 翻译后的 OpenAI chunk 立刻通过 onChunk 回调直通给 pi，不做缓冲
 *
 * 失败处理：
 *  - 本层不做自动重试。任何失败（DeepSeek 报错、空响应、流卡死）都按
 *    OpenAI 兼容流的形态收尾（content delta 注入错误说明 + finish_reason
 *    'stop' + [DONE]），由调用方（pi 客户端）自行决定是否重试，对齐主线
 *    OpenAI SDK 行为。
 *
 * 卡死检测（stall watchdog）：
 *  - 从首个 thinking/content chunk 开始计时，每收到任意 incoming（包括
 *    end/error）就 reset；超时阈值默认 5s
 *  - 触发时把"模型响应超时"错误塞进流尾部，并通知 renderer 放弃这次请求
 *
 * 与 renderer 的 IPC 协议：
 *   main → renderer:  channel "llm:run"     payload { requestId, prompt }
 *                     channel "llm:abort"   payload { requestId }
 *   renderer → main:  channel "llm:thinking"  { requestId, delta }
 *                     channel "llm:content"   { requestId, delta }
 *                     channel "llm:end"       { requestId }
 *                     channel "llm:error"     { requestId, message }
 */

const { ipcMain } = require('electron');
const { buildPrompt } = require('./protocol/build-prompt');
const { createTranslator } = require('./protocol/parse-stream');

const STALL_TIMEOUT_MS = 5000;       // 流卡死阈值：相邻 chunk 间隔超过此值即视为失败
const STALL_MESSAGE = '模型响应超时（5s 无新内容），本次回复中断';

class LlmBridge {
  constructor(opts) {
    this._webContents = null;
    this._counter = 0;
    this._pending = new Map();      // requestId → in-flight state
    this._queue = [];               // FIFO of dispatch functions waiting for the page
    this._busy = false;
    this._getTemplate = (opts && typeof opts.getTemplate === 'function') ? opts.getTemplate : null;
    this._log = (opts && typeof opts.log === 'function') ? opts.log : null;
    this._stallTimeoutMs = (opts && Number.isFinite(opts.stallTimeoutMs)) ? opts.stallTimeoutMs : STALL_TIMEOUT_MS;

    ipcMain.on('llm:thinking', (_e, payload) => this._onIncoming('thinking', payload));
    ipcMain.on('llm:content',  (_e, payload) => this._onIncoming('content', payload));
    ipcMain.on('llm:end',      (_e, payload) => this._onIncoming('end', payload));
    ipcMain.on('llm:error',    (_e, payload) => this._onIncoming('error', payload));
  }

  attach(webContents) {
    this._webContents = webContents;
  }

  isReady() {
    return !!this._webContents && !this._webContents.isDestroyed();
  }

  /**
   * Run one OpenAI chat completion against DeepSeek.
   *
   * @param {object} opts
   * @param {object} opts.body      - OpenAI request body (messages, tools, ...)
   * @param {function} opts.onChunk - called with each translated OpenAI chunk (live, as they arrive)
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<void>} resolves when stream is fully drained.
   */
  request(opts) {
    return new Promise((resolve, reject) => {
      if (!opts || typeof opts.onChunk !== 'function') {
        reject(new Error('LlmBridge.request: onChunk required'));
        return;
      }
      const task = () => this._dispatch(opts, resolve, reject);
      this._queue.push(task);
      this._drain();
    });
  }

  _drain() {
    if (this._busy) return;
    const next = this._queue.shift();
    if (!next) return;
    this._busy = true;
    try {
      next();
    } catch (err) {
      this._busy = false;
      setImmediate(() => this._drain());
      throw err;
    }
  }

  _logEvent(tag, payload) {
    if (this._log) try { this._log(tag, payload); } catch (_) {}
  }

  _dispatch(opts, resolve, reject) {
    if (!this.isReady()) {
      this._finishRequest(null, reject, new Error('DeepSeek webview not ready'));
      return;
    }

    const body = opts.body || {};
    const requestId = ++this._counter;
    let prompt;
    try {
      const template = this._getTemplate ? this._getTemplate() : undefined;
      prompt = buildPrompt(body, { template });
    } catch (err) {
      this._finishRequest(null, reject, err);
      return;
    }

    const model = body.model || 'deepseek-via-web';

    const handle = {
      requestId,
      resolve,
      reject,
      onChunk: opts.onChunk,
      signal: opts.signal || null,
      onAbort: null,
      aborted: false,
      prompt,
      model,
    };

    if (handle.signal) {
      if (handle.signal.aborted) {
        handle.aborted = true;
      } else {
        handle.onAbort = () => {
          handle.aborted = true;
          this._sendAbort(requestId);
        };
        handle.signal.addEventListener('abort', handle.onAbort);
      }
    }

    this._launch(handle);
  }

  /**
   * Issue the request to the DeepSeek webview. Translator output streams
   * straight to `handle.onChunk`; no per-attempt buffer, no retry.
   */
  _launch(handle) {
    if (handle.aborted) {
      this._finishRequest(handle, handle.reject, new Error('aborted'));
      return;
    }

    let contentLen = 0;
    let toolCallsLen = 0;
    let reasoningLen = 0;
    let hadError = false;
    let errorMessage = null;

    const translator = createTranslator({
      id: 'chatcmpl-' + handle.requestId,
      model: handle.model,
      emit: (chunk) => {
        const choice = chunk.choices && chunk.choices[0];
        const d = choice && choice.delta;
        if (d) {
          if (typeof d.content === 'string') contentLen += d.content.length;
          if (typeof d.reasoning_content === 'string') reasoningLen += d.reasoning_content.length;
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              if (tc && tc.function && typeof tc.function.name === 'string' && tc.function.name) toolCallsLen++;
            }
          }
        }
        if (!handle.aborted) {
          try { handle.onChunk(chunk); } catch (_) {}
        }
      },
    });

    const state = {
      handle,
      translator,
      counters: () => ({ contentLen, toolCallsLen, reasoningLen, hadError, errorMessage }),
      markError: (msg) => { hadError = true; errorMessage = msg; },
      finalized: false,
      stallTimer: null,
    };
    this._pending.set(handle.requestId, state);

    this._logEvent('llm:attempt', {
      requestId: handle.requestId,
      promptLen: handle.prompt.length,
    });
    this._webContents.send('llm:run', { requestId: handle.requestId, prompt: handle.prompt });
  }

  _armStallTimer(state) {
    this._clearStallTimer(state);
    if (this._stallTimeoutMs <= 0) return;
    state.stallTimer = setTimeout(() => this._onStall(state), this._stallTimeoutMs);
  }

  _clearStallTimer(state) {
    if (state.stallTimer) {
      clearTimeout(state.stallTimer);
      state.stallTimer = null;
    }
  }

  _onStall(state) {
    state.stallTimer = null;
    if (state.finalized) return;
    state.markError('stalled');
    try { state.translator.fail(STALL_MESSAGE); } catch (_) {}
    this._sendAbort(state.handle.requestId);
    this._finalizeAttempt(state);
  }

  _finalizeAttempt(state) {
    if (state.finalized) return;
    state.finalized = true;
    this._clearStallTimer(state);
    this._pending.delete(state.handle.requestId);

    const { contentLen, toolCallsLen, reasoningLen, hadError, errorMessage } = state.counters();
    this._logEvent('llm:attempt-done', {
      requestId: state.handle.requestId,
      contentLen, toolCallsLen, reasoningLen,
      hadError, errorMessage,
    });

    if (state.handle.aborted) {
      this._finishRequest(state.handle, state.handle.reject, new Error('aborted'));
    } else {
      this._finishRequest(state.handle, state.handle.resolve, undefined);
    }
  }

  _onIncoming(kind, payload) {
    if (!payload || typeof payload.requestId !== 'number') return;
    const state = this._pending.get(payload.requestId);
    if (!state) return;
    try {
      if (kind === 'thinking') {
        if (!state.handle.aborted) state.translator.pushReasoning(payload.delta || '');
        this._armStallTimer(state);
      } else if (kind === 'content') {
        if (!state.handle.aborted) state.translator.pushContent(payload.delta || '');
        this._armStallTimer(state);
      } else if (kind === 'end') {
        state.translator.end();
        this._finalizeAttempt(state);
      } else if (kind === 'error') {
        state.markError(payload.message || 'unknown error');
        state.translator.fail(payload.message || 'unknown error');
        this._finalizeAttempt(state);
      }
    } catch (err) {
      state.markError(err.message);
      try { state.translator.fail(err.message); } catch (_) {}
      this._finalizeAttempt(state);
    }
  }

  _sendAbort(requestId) {
    if (this.isReady()) {
      this._webContents.send('llm:abort', { requestId });
    }
  }

  _finishRequest(handle, settle, errOrUndef) {
    if (handle) {
      if (handle.signal && handle.onAbort) {
        handle.signal.removeEventListener('abort', handle.onAbort);
      }
    }
    this._busy = false;
    if (errOrUndef instanceof Error) settle(errOrUndef);
    else settle();
    setImmediate(() => this._drain());
  }
}

module.exports = { LlmBridge };
