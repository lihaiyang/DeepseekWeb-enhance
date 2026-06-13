'use strict';

/**
 * Unit tests for LlmBridge. We stub electron's `ipcMain` via
 * Module.prototype.require interception so the bridge thinks it's
 * running in main.
 */

const Module = require('module');

// ── Electron stub ────────────────────────────────────────────────────
const ipcListeners = {};
const ipcMainStub = {
  on(channel, fn) { ipcListeners[channel] = fn; },
  emit(channel, payload) {
    const fn = ipcListeners[channel];
    if (fn) fn({}, payload);
  },
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (name) {
  if (name === 'electron') return { ipcMain: ipcMainStub };
  return origRequire.call(this, name);
};

const { LlmBridge } = require('../src/main/llm-bridge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (info ? ' — ' + info : '')); }
}

function makeBridge(opts) {
  const sent = [];
  const bridge = new LlmBridge(opts || {});
  bridge.attach({
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  });
  return { bridge, sent };
}

function deltaContent(chunks) {
  return chunks.map((c) => c.choices[0].delta.content).filter((x) => typeof x === 'string').join('');
}
function deltaReasoning(chunks) {
  return chunks.map((c) => c.choices[0].delta.reasoning_content).filter((x) => typeof x === 'string').join('');
}
function finishReason(chunks) {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const fr = chunks[i].choices[0].finish_reason;
    if (fr) return fr;
  }
  return null;
}
function toolCallNames(chunks) {
  const names = new Set();
  for (const c of chunks) {
    const tcs = c.choices[0].delta.tool_calls;
    if (!tcs) continue;
    for (const tc of tcs) {
      if (tc && tc.function && tc.function.name) names.add(tc.function.name);
    }
  }
  return Array.from(names);
}

async function captureRejection(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

(async () => {
  // 1. Happy path — content arrives live (before end), no retry.
  {
    const { bridge, sent } = makeBridge();
    const collected = [];
    let contentBeforeEnd = '';
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid = sent[0].payload.requestId;
    ipcMainStub.emit('llm:content', { requestId: rid, delta: '答案是 42' });
    // Snapshot what pi has seen BEFORE we send `end`.
    contentBeforeEnd = deltaContent(collected);
    ipcMainStub.emit('llm:end', { requestId: rid });
    await p;
    check('happy: single attempt', sent.length === 1);
    check('happy: content streamed live (visible before end)', contentBeforeEnd === '答案是 42',
      'saw "' + contentBeforeEnd + '" before end');
    check('happy: full content reaches user', deltaContent(collected) === '答案是 42');
    check('happy: finish_reason stop', finishReason(collected) === 'stop');
  }

  // 2. Thinking-only then end — reject as a bad upstream response. pi needs
  // content or a tool call; reasoning alone is not consumable output.
  {
    const { bridge, sent } = makeBridge();
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid = sent[0].payload.requestId;
    ipcMainStub.emit('llm:thinking', { requestId: rid, delta: '想啊想' });
    ipcMainStub.emit('llm:end', { requestId: rid });
    const err = await captureRejection(p);
    check('thinking-only: single attempt (no auto-retry)', sent.length === 1);
    check('thinking-only: reasoning visible', deltaReasoning(collected) === '想啊想');
    check('thinking-only: content empty', deltaContent(collected) === '');
    check('thinking-only: request rejected',
      err && /未返回可用正文/.test(err.message), err && err.message);
    check('thinking-only: no normal finish', finishReason(collected) === null);
  }

  // 3. Stream error mid-content — partial content already flowed; the
  // request rejects without appending fake assistant content.
  {
    const { bridge, sent } = makeBridge();
    const collected = [];
    let contentBeforeError = '';
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid = sent[0].payload.requestId;
    ipcMainStub.emit('llm:content', { requestId: rid, delta: 'partial' });
    contentBeforeError = deltaContent(collected);
    ipcMainStub.emit('llm:error', { requestId: rid, message: 'network blip' });
    const err = await captureRejection(p);
    check('error: single attempt (no auto-retry)', sent.length === 1);
    check('error: partial content streamed before error', contentBeforeError === 'partial');
    check('error: request rejected',
      err && err.message === 'network blip', err && err.message);
    check('error: no fake error content appended',
      !/\[stream error: network blip\]/.test(deltaContent(collected)));
    check('error: no normal finish', finishReason(collected) === null);
  }

  // 4. Stall detection — first chunk arrives, then renderer goes silent;
  // bridge fires the stall timer, surfaces a Chinese error, and aborts.
  {
    const { bridge, sent } = makeBridge({ stallTimeoutMs: 50 });
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid = sent[0].payload.requestId;
    ipcMainStub.emit('llm:content', { requestId: rid, delta: '开始回答' });
    // Now stay quiet — let the watchdog fire.
    const err = await captureRejection(p);
    check('stall: single attempt', sent.filter((s) => s.channel === 'llm:run').length === 1);
    check('stall: live content kept', /开始回答/.test(deltaContent(collected)));
    check('stall: request rejected',
      err && /模型响应超时/.test(err.message), err && err.message);
    check('stall: timeout not appended as content',
      !/模型响应超时/.test(deltaContent(collected)));
    check('stall: no normal finish', finishReason(collected) === null);
    check('stall: renderer notified to abort',
      sent.some((s) => s.channel === 'llm:abort' && s.payload.requestId === rid));
  }

  // 5. Stall timer resets on each chunk — slow but steady stream should
  // not trip the watchdog.
  {
    const { bridge, sent } = makeBridge({ stallTimeoutMs: 80 });
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid = sent[0].payload.requestId;
    for (let i = 0; i < 5; i++) {
      ipcMainStub.emit('llm:content', { requestId: rid, delta: 'tick ' });
      await sleep(40); // < stallTimeoutMs, so timer should keep resetting
    }
    ipcMainStub.emit('llm:end', { requestId: rid });
    await p;
    check('slow stream: not flagged as stall',
      !/模型响应超时/.test(deltaContent(collected)));
    check('slow stream: all ticks delivered',
      deltaContent(collected) === 'tick tick tick tick tick ');
    check('slow stream: finish_reason stop', finishReason(collected) === 'stop');
  }

  // 6. Tool call counts as content — finish_reason flips to tool_calls,
  // streamed live as the fence closes.
  {
    const { bridge, sent } = makeBridge();
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'list files' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid = sent[0].payload.requestId;
    ipcMainStub.emit('llm:content', { requestId: rid, delta: '```tool_call\n{"name":"ls","arguments":{}}\n```' });
    ipcMainStub.emit('llm:end', { requestId: rid });
    await p;
    check('tool only: single attempt', sent.length === 1);
    check('tool only: tool emitted', toolCallNames(collected).indexOf('ls') !== -1);
    check('tool only: finish_reason tool_calls', finishReason(collected) === 'tool_calls');
  }

  // 7. Thinking followed by a tool_call whose closing fence sits at the
  // stream tail: translator only emits the tool during end(), so the
  // reasoning-only guard must not fire early.
  {
    const { bridge, sent } = makeBridge();
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'list files' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid = sent[0].payload.requestId;
    ipcMainStub.emit('llm:thinking', { requestId: rid, delta: '需要列目录' });
    ipcMainStub.emit('llm:content', { requestId: rid, delta: '```tool_call\n{"name":"ls","arguments":{}}\n```' });
    ipcMainStub.emit('llm:end', { requestId: rid });
    const err = await captureRejection(p);
    check('thinking+tail-tool: request resolved', err === null, err && err.message);
    check('thinking+tail-tool: reasoning visible', deltaReasoning(collected) === '需要列目录');
    check('thinking+tail-tool: tool emitted', toolCallNames(collected).indexOf('ls') !== -1);
    check('thinking+tail-tool: finish_reason tool_calls', finishReason(collected) === 'tool_calls');
  }

  // 8. Stopped retry config is passed to the DeepSeek renderer.
  {
    const cfg = { maxRetries: 2, delayMs: 650, prompt: '继续' };
    const { bridge, sent } = makeBridge({ getStoppedRetryConfig: () => cfg });
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid = sent[0].payload.requestId;
    ipcMainStub.emit('llm:content', { requestId: rid, delta: 'ok' });
    ipcMainStub.emit('llm:end', { requestId: rid });
    await p;
    check('stopped-retry config: attached to run payload',
      sent[0].payload.stoppedRetry &&
      sent[0].payload.stoppedRetry.maxRetries === 2 &&
      sent[0].payload.stoppedRetry.delayMs === 650 &&
      sent[0].payload.stoppedRetry.prompt === '继续');
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
