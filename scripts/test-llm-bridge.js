'use strict';

/**
 * Unit tests for LlmBridge retry behaviour. We stub electron's `ipcMain`
 * via Module.prototype.require interception so the bridge thinks it's
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

function makeBridge() {
  const sent = [];
  const bridge = new LlmBridge({ maxAttempts: 3, retryDelayMs: 5 });
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

(async () => {
  // 1. Normal happy path: content arrives, no retry.
  {
    const { bridge, sent } = makeBridge();
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid = sent[0].payload.requestId;
    ipcMainStub.emit('llm:content', { requestId: rid, delta: '答案是 42' });
    ipcMainStub.emit('llm:end', { requestId: rid });
    await p;
    check('happy: single attempt', sent.length === 1);
    check('happy: content reaches user', deltaContent(collected) === '答案是 42');
    check('happy: finish_reason stop', finishReason(collected) === 'stop');
  }

  // 2. Thinking-only then end → must retry and second attempt's content
  // is what reaches the caller; first attempt's reasoning is suppressed.
  {
    const { bridge, sent } = makeBridge();
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid1 = sent[0].payload.requestId;
    ipcMainStub.emit('llm:thinking', { requestId: rid1, delta: '想啊想' });
    ipcMainStub.emit('llm:end', { requestId: rid1 });

    // wait for retry
    await sleep(30);
    check('retry: second attempt issued', sent.length === 2);
    const rid2 = sent[1].payload.requestId;
    check('retry: retry uses same requestId', rid1 === rid2);
    ipcMainStub.emit('llm:thinking', { requestId: rid2, delta: '再想' });
    ipcMainStub.emit('llm:content', { requestId: rid2, delta: 'OK 答案' });
    ipcMainStub.emit('llm:end', { requestId: rid2 });
    await p;
    check('retry: only second attempt content visible', deltaContent(collected) === 'OK 答案');
    check('retry: first reasoning dropped', deltaReasoning(collected) === '再想');
    check('retry: finish_reason stop', finishReason(collected) === 'stop');
  }

  // 3. Stream error then success.
  {
    const { bridge, sent } = makeBridge();
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    await sleep(10);
    const rid1 = sent[0].payload.requestId;
    ipcMainStub.emit('llm:content', { requestId: rid1, delta: 'partial' });
    ipcMainStub.emit('llm:error', { requestId: rid1, message: 'network blip' });

    await sleep(30);
    check('error retry: second attempt issued', sent.length === 2);
    const rid2 = sent[1].payload.requestId;
    ipcMainStub.emit('llm:content', { requestId: rid2, delta: 'recovered ok' });
    ipcMainStub.emit('llm:end', { requestId: rid2 });
    await p;
    check('error retry: caller sees recovery only', deltaContent(collected) === 'recovered ok');
  }

  // 4. All attempts empty — must give up after MAX_ATTEMPTS and resolve
  // (not hang).
  {
    const { bridge, sent } = makeBridge();
    const collected = [];
    const p = bridge.request({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      onChunk: (c) => collected.push(c),
    });
    for (let i = 0; i < 3; i++) {
      await sleep(15);
      const rid = sent[i].payload.requestId;
      ipcMainStub.emit('llm:thinking', { requestId: rid, delta: '想' });
      ipcMainStub.emit('llm:end', { requestId: rid });
    }
    await p;
    check('exhausted retries: 3 attempts', sent.length === 3);
    check('exhausted retries: resolves with finish_reason', finishReason(collected) === 'stop');
  }

  // 5. Tool call counts as "non-empty" — no retry triggered.
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
    check('tool only: no retry', sent.length === 1);
    check('tool only: tool emitted', toolCallNames(collected).indexOf('ls') !== -1);
    check('tool only: finish_reason tool_calls', finishReason(collected) === 'tool_calls');
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
