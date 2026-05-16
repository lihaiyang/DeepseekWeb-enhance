'use strict';

/**
 * LlmBridge — main 进程一侧的 LLM 调用调度器
 *
 * 负责：
 *  - 把 OpenAI 兼容的请求体翻成 DeepSeek prompt
 *  - 把请求 dispatch 到 DeepSeek webview（main world 里的 DeepSeekClient）
 *  - 串行队列：DeepSeek 页面同时只能有一个 in-flight 请求
 *  - 接收 renderer 回来的 thinking/content 增量，喂给 stream translator
 *  - 翻译后的 OpenAI chunk 先 buffer 起来，整个回合结束后才 flush 给 pi
 *    这样我们可以在"模型只思考没回答"的异常情形下静默重试，pi 看不到中
 *    间过程
 *  - 翻译后的 OpenAI chunk 通过 onChunk 回调送出
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

const MAX_ATTEMPTS = 3;            // total tries per request (1 + 2 retries)
const RETRY_DELAY_MS = 500;        // back-off before re-issuing to DeepSeek

class LlmBridge {
  constructor(opts) {
    this._webContents = null;
    this._counter = 0;
    this._pending = new Map();      // requestId → in-flight attempt state
    this._queue = [];               // FIFO of dispatch functions waiting for the page
    this._busy = false;
    this._getTemplate = (opts && typeof opts.getTemplate === 'function') ? opts.getTemplate : null;
    this._log = (opts && typeof opts.log === 'function') ? opts.log : null;
    this._maxAttempts = (opts && Number.isFinite(opts.maxAttempts)) ? opts.maxAttempts : MAX_ATTEMPTS;
    this._retryDelayMs = (opts && Number.isFinite(opts.retryDelayMs)) ? opts.retryDelayMs : RETRY_DELAY_MS;

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
   * @param {function} opts.onChunk - called with each translated OpenAI chunk
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

    // Per-request top-level handle. attempt-specific state lives in _pending.
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

    this._launchAttempt(handle, 0);
  }

  /**
   * Issue one attempt of the request to the DeepSeek webview. The attempt's
   * chunks are accumulated in `state.collected` until end/error, then
   * `_finalizeAttempt` decides whether to retry or flush to the caller.
   */
  _launchAttempt(handle, attempt) {
    if (handle.aborted) {
      this._finishRequest(handle, handle.reject, new Error('aborted'));
      return;
    }

    const collected = [];
    let contentLen = 0;
    let toolCallsLen = 0;
    let reasoningLen = 0;
    let hadError = false;
    let errorMessage = null;

    const translator = createTranslator({
      id: 'chatcmpl-' + handle.requestId + (attempt > 0 ? '-r' + attempt : ''),
      model: handle.model,
      emit: (chunk) => {
        collected.push(chunk);
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
      },
    });

    const state = {
      handle,
      attempt,
      translator,
      collected,
      counters: () => ({ contentLen, toolCallsLen, reasoningLen, hadError, errorMessage }),
      markError: (msg) => { hadError = true; errorMessage = msg; },
      finalized: false,
    };
    this._pending.set(handle.requestId, state);

    this._logEvent('llm:attempt', {
      requestId: handle.requestId,
      attempt,
      promptLen: handle.prompt.length,
    });
    this._webContents.send('llm:run', { requestId: handle.requestId, prompt: handle.prompt });
  }

  _finalizeAttempt(state) {
    if (state.finalized) return;
    state.finalized = true;
    this._pending.delete(state.handle.requestId);

    const { contentLen, toolCallsLen, reasoningLen, hadError, errorMessage } = state.counters();
    const empty = contentLen === 0 && toolCallsLen === 0;
    const nextAttempt = state.attempt + 1;
    const canRetry = nextAttempt < this._maxAttempts && !state.handle.aborted;

    // Retry conditions: stream errored, or model produced no content + no
    // tool calls (typical "thought, then bailed" behaviour).
    const wantRetry = canRetry && (hadError || empty);

    this._logEvent('llm:attempt-done', {
      requestId: state.handle.requestId,
      attempt: state.attempt,
      contentLen, toolCallsLen, reasoningLen,
      hadError, errorMessage,
      retrying: wantRetry,
    });

    if (wantRetry) {
      setTimeout(() => this._launchAttempt(state.handle, nextAttempt), this._retryDelayMs);
      return;
    }

    // Flush the (winning) attempt's chunks to the caller.
    for (const chunk of state.collected) {
      try { state.handle.onChunk(chunk); } catch (_) {}
    }

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
      } else if (kind === 'content') {
        if (!state.handle.aborted) state.translator.pushContent(payload.delta || '');
      } else if (kind === 'end') {
        state.translator.end();
        this._finalizeAttempt(state);
      } else if (kind === 'error') {
        state.markError(payload.message || 'unknown error');
        state.translator.fail(payload.message || 'unknown error');
        this._finalizeAttempt(state);
      }
    } catch (err) {
      // Translator threw — count as error attempt and try again if we can.
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
