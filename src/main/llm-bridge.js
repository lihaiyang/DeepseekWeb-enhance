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
 *  - 本层不做自动重试。任何失败（DeepSeek 报错、空响应、流卡死）都
 *    reject 给 HTTP shim，由 HTTP 层按 OpenAI 兼容错误事件关闭流。
 *
 * 卡死检测（stall watchdog）：
 *  - 从首个 thinking/content chunk 开始计时，每收到任意 incoming（包括
 *    end/error）就 reset；超时阈值默认 5s
 *  - 触发时把"模型响应超时"错误塞进流尾部，并通知 renderer 放弃这次请求
 *
 * 与 renderer 的 IPC 协议：
 *   main → renderer:  channel "llm:run"     payload { requestId, prompt, mode }
 *                     channel "llm:abort"   payload { requestId }
 *   renderer → main:  channel "llm:thinking"  { requestId, delta }
 *                     channel "llm:content"   { requestId, delta }
 *                     channel "llm:end"       { requestId }
 *                     channel "llm:error"     { requestId, message }
 */

const { ipcMain } = require('electron');
const { buildPrompt, buildContinuationPrompt } = require('./protocol/build-prompt');
const { createTranslator } = require('./protocol/parse-stream');

const STALL_TIMEOUT_MS = 5000;       // 流卡死阈值：相邻 chunk 间隔超过此值即视为失败
const STALL_MESSAGE = '模型响应超时（5s 无新内容），本次回复中断';
const REASONING_ONLY_MESSAGE = 'DeepSeek 未返回可用正文（仅收到思考内容）';

// Session constants — 控制同一个 DeepSeek 聊天窗口的复用
// DeepSeek 上下文窗口 1M tokens，输入框单次最大 ~500k tokens
// 按 3 chars/token 保守估算：1,500,000 chars ≈ 500k tokens prompt
// 加上模型回复占用，总上下文 ≈ 1M tokens，留有余量
const MAX_SESSION_CHARS = 1500000;
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

class LlmBridge {
  constructor(opts) {
    this._webContents = null;
    this._counter = 0;
    this._pending = new Map();      // requestId → in-flight state
    this._queue = [];               // FIFO of dispatch functions waiting for the page
    this._busy = false;
    this._getTemplate = (opts && typeof opts.getTemplate === 'function') ? opts.getTemplate : null;
    this._getMode = (opts && typeof opts.getMode === 'function') ? opts.getMode : null;
    this._log = (opts && typeof opts.log === 'function') ? opts.log : null;
    this._stallTimeoutMs = (opts && Number.isFinite(opts.stallTimeoutMs)) ? opts.stallTimeoutMs : STALL_TIMEOUT_MS;

    // Session state — 同一个 DeepSeek 聊天窗口的续接追踪
    this._session = { messageCount: 0, totalChars: 0, active: false };

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
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const requestId = ++this._counter;
    let prompt;
    let isContinuation = false;

    // ─── 会话续接判断 ───────────────────────────────────────────
    // 条件：session 活跃 + 未超 token 上限 + 本轮消息数 > 上轮消息数
    if (this._session.active && this._session.totalChars < MAX_SESSION_CHARS) {
      if (messages.length > this._session.messageCount) {
        isContinuation = true;
      }
    }

    if (isContinuation) {
      // 续接：只格式化增量消息，不重复注入约束/工具/协议
      try {
        const startIndex = this._session.messageCount;
        prompt = buildContinuationPrompt(messages, startIndex);
      } catch (err) {
        // 增量构建失败 → 降级为完整 prompt 重建 + 新建会话
        this._logEvent('llm:continuation-fallback', { error: err.message });
        isContinuation = false;
        this._session = { messageCount: 0, totalChars: 0, active: false };
        try {
          const template = this._getTemplate ? this._getTemplate() : undefined;
          prompt = buildPrompt(body, { template });
        } catch (err2) {
          this._finishRequest(null, reject, err2);
          return;
        }
      }
    } else {
      // 新会话：完整 prompt 构建，重置会话追踪
      this._session = { messageCount: 0, totalChars: 0, active: false };
      try {
        const template = this._getTemplate ? this._getTemplate() : undefined;
        prompt = buildPrompt(body, { template });
      } catch (err) {
        this._finishRequest(null, reject, err);
        return;
      }
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
      isContinuation,
      _body: body,  // 保留原始 body 供 _finalizeAttempt 更新 session
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
    let rawContentLen = 0;
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
      counters: () => ({ contentLen, rawContentLen, toolCallsLen, reasoningLen, hadError, errorMessage }),
      noteRawContent: (delta) => { if (typeof delta === 'string') rawContentLen += delta.length; },
      markError: (msg) => { hadError = true; errorMessage = msg; },
      finalized: false,
      stallTimer: null,
    };
    this._pending.set(handle.requestId, state);

    this._logEvent('llm:attempt', {
      requestId: handle.requestId,
      promptLen: handle.prompt.length,
      isContinuation: handle.isContinuation,
      sessionChars: this._session.totalChars,
    });
    const mode = this._getMode ? this._getMode() : 'expert';
    this._webContents.send('llm:run', {
      requestId: handle.requestId,
      prompt: handle.prompt,
      mode: mode,
      isContinuation: handle.isContinuation,
    });
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
    state.markError(STALL_MESSAGE);
    this._sendAbort(state.handle.requestId);
    this._finalizeAttempt(state);
  }

  _finalizeAttempt(state) {
    if (state.finalized) return;
    state.finalized = true;
    this._clearStallTimer(state);
    this._pending.delete(state.handle.requestId);

    const { contentLen, rawContentLen, toolCallsLen, reasoningLen, hadError, errorMessage } = state.counters();
    this._logEvent('llm:attempt-done', {
      requestId: state.handle.requestId,
      contentLen, rawContentLen, toolCallsLen, reasoningLen,
      hadError, errorMessage,
    });

    // 更新会话追踪
    if (!hadError) {
      const body = state.handle._body;
      const messages = (body && Array.isArray(body.messages)) ? body.messages : [];
      this._session.messageCount = messages.length;
      this._session.totalChars += state.handle.prompt.length;
      this._session.active = true;
      this._logEvent('llm:session', {
        messageCount: this._session.messageCount,
        totalChars: this._session.totalChars,
        estimatedTokens: estimateTokens(String(this._session.totalChars)),
      });
    } else if (hadError) {
      // 任何中断/错误后都让下次请求降级为完整 prompt 重建
      this._session.active = false;
    }

    if (state.handle.aborted) {
      this._finishRequest(state.handle, state.handle.reject, new Error('aborted'));
    } else if (hadError) {
      this._finishRequest(state.handle, state.handle.reject, new Error(errorMessage || 'unknown stream error'));
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
        if (!state.handle.aborted) {
          state.noteRawContent(payload.delta || '');
          state.translator.pushContent(payload.delta || '');
        }
        this._armStallTimer(state);
      } else if (kind === 'end') {
        const counts = state.counters();
        if (counts.reasoningLen > 0 && counts.rawContentLen === 0 &&
            counts.contentLen === 0 && counts.toolCallsLen === 0) {
          state.markError(REASONING_ONLY_MESSAGE);
          this._finalizeAttempt(state);
        } else {
          state.translator.end();
          this._finalizeAttempt(state);
        }
      } else if (kind === 'error') {
        state.markError(payload.message || 'unknown error');
        this._finalizeAttempt(state);
      }
    } catch (err) {
      state.markError(err.message);
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
