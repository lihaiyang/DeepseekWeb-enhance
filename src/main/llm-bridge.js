'use strict';

/**
 * LlmBridge — main 进程一侧的 LLM 调用调度器
 *
 * 负责：
 *  - 把 OpenAI 兼容的请求体翻成 DeepSeek prompt
 *  - 把请求 dispatch 到 DeepSeek webview（main world 里的 DeepSeekClient）
 *  - 串行队列：DeepSeek 页面同时只能有一个 in-flight 请求
 *  - 接收 renderer 回来的 thinking/content 增量，喂给 stream translator
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

class LlmBridge {
  constructor() {
    this._webContents = null;
    this._counter = 0;
    this._pending = new Map();      // requestId → in-flight state
    this._queue = [];               // FIFO of dispatch functions waiting for the page
    this._busy = false;

    ipcMain.on('llm:thinking', (_e, payload) => this._onIncoming('thinking', payload));
    ipcMain.on('llm:content',  (_e, payload) => this._onIncoming('content', payload));
    ipcMain.on('llm:end',      (_e, payload) => this._onIncoming('end', payload));
    ipcMain.on('llm:error',    (_e, payload) => this._onIncoming('error', payload));
  }

  /**
   * Bind to the DeepSeek webview's webContents. Must be called after the
   * view is created and before any request() lands.
   */
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

  _dispatch(opts, resolve, reject) {
    if (!this.isReady()) {
      this._finish(null, reject, new Error('DeepSeek webview not ready'));
      return;
    }

    const body = opts.body || {};
    const requestId = ++this._counter;
    let prompt;
    try {
      prompt = buildPrompt(body);
    } catch (err) {
      this._finish(null, reject, err);
      return;
    }

    const model = body.model || 'deepseek-via-web';
    const translator = createTranslator({
      id: 'chatcmpl-' + requestId,
      model: model,
      emit: opts.onChunk,
    });

    const state = {
      requestId,
      translator,
      resolve,
      reject,
      aborted: false,
      signal: opts.signal || null,
      onAbort: null,
    };

    if (state.signal) {
      if (state.signal.aborted) {
        state.aborted = true;
      } else {
        state.onAbort = () => {
          state.aborted = true;
          this._sendAbort(requestId);
        };
        state.signal.addEventListener('abort', state.onAbort);
      }
    }

    this._pending.set(requestId, state);
    this._webContents.send('llm:run', { requestId, prompt });
  }

  _onIncoming(kind, payload) {
    if (!payload || typeof payload.requestId !== 'number') return;
    const state = this._pending.get(payload.requestId);
    if (!state) return;
    try {
      if (kind === 'thinking') {
        if (!state.aborted) state.translator.pushReasoning(payload.delta || '');
      } else if (kind === 'content') {
        if (!state.aborted) state.translator.pushContent(payload.delta || '');
      } else if (kind === 'end') {
        state.translator.end();
        this._finish(state, state.resolve, undefined);
      } else if (kind === 'error') {
        state.translator.fail(payload.message || 'unknown error');
        this._finish(state, state.resolve, undefined);
      }
    } catch (err) {
      this._finish(state, state.reject, err);
    }
  }

  _sendAbort(requestId) {
    if (this.isReady()) {
      this._webContents.send('llm:abort', { requestId });
    }
  }

  _finish(state, settle, errOrUndef) {
    if (state) {
      if (state.signal && state.onAbort) {
        state.signal.removeEventListener('abort', state.onAbort);
      }
      this._pending.delete(state.requestId);
    }
    this._busy = false;
    if (errOrUndef instanceof Error) settle(errOrUndef);
    else settle();
    setImmediate(() => this._drain());
  }
}

module.exports = { LlmBridge };
