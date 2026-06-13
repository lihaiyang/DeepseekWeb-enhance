'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (info ? ' — ' + info : '')); }
}

async function captureRejection(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

function makeDocument() {
  return {
    body: {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

function makeAdapter(steps) {
  const adapter = {
    sent: [],
    _thinkingCallbacks: [],
    _contentCallbacks: [],
    _endCallbacks: [],
    _errorCallbacks: [],
    onThinking(fn) { this._thinkingCallbacks.push(fn); },
    onContent(fn) { this._contentCallbacks.push(fn); },
    onEnd(fn) { this._endCallbacks.push(fn); },
    onError(fn) { this._errorCallbacks.push(fn); },
    abort() {},
    sendMessage(text) {
      this.sent.push(text);
      const step = steps[this.sent.length - 1] || {};
      return Promise.resolve().then(() => {
        if (typeof step.content === 'string') {
          this._contentCallbacks.slice().forEach((fn) => fn(step.content));
        }
        if (step.error) throw new Error(step.error);
        return step.result || step.content || '';
      });
    },
  };
  return adapter;
}

function makeClient(steps, retryConfig) {
  const adapter = makeAdapter(steps);
  const windowObj = {
    __dsAgentAdapter: adapter,
    __dsAgentMode: 'expert',
    __dsAgentStoppedRetry: retryConfig || { maxRetries: 1, delayMs: 0, prompt: '继续' },
    __dsAgentToolHint: '',
    dsAgent: { debugLog: () => {} },
  };
  const context = {
    window: windowObj,
    document: makeDocument(),
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Number,
    String,
    Error,
    Date,
    Math,
    RegExp,
  };
  windowObj.window = windowObj;
  windowObj.document = context.document;
  windowObj.console = console;
  windowObj.setTimeout = setTimeout;
  windowObj.clearTimeout = clearTimeout;
  windowObj.Promise = Promise;
  context.getComputedStyle = () => ({ cursor: 'default' });
  windowObj.getComputedStyle = context.getComputedStyle;

  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'api', 'DeepSeekClient.js'), 'utf-8');
  vm.runInNewContext(code, context, { filename: 'DeepSeekClient.js' });
  const client = new windowObj.DeepSeekClient();
  return { client, adapter };
}

(async () => {
  {
    const { client, adapter } = makeClient([
      { content: 'partial ', error: 'DeepSeek 回复已停止，未返回可用正文' },
      { content: 'done', result: 'partial done' },
    ], { maxRetries: 1, delayMs: 0, prompt: '继续' });
    const deltas = [];
    client.onContent((d) => deltas.push(d));
    const err = await captureRejection(client.sendContinuation('original'));
    check('stopped retry: request resolves', err === null, err && err.message);
    check('stopped retry: sends original then continuation',
      adapter.sent.join('|') === 'original|继续', adapter.sent.join('|'));
    check('stopped retry: streams both attempts', deltas.join('') === 'partial done', deltas.join(''));
  }

  {
    const { client, adapter } = makeClient([
      { content: 'partial ', error: 'DeepSeek 回复已停止，未返回可用正文' },
    ], { maxRetries: 0, delayMs: 0, prompt: '继续' });
    const err = await captureRejection(client.sendContinuation('original'));
    check('stopped retry disabled: rejects', err && /已停止/.test(err.message), err && err.message);
    check('stopped retry disabled: single send', adapter.sent.length === 1, String(adapter.sent.length));
  }

  {
    const tool = '```tool_call\n{"name":"bash","arguments":{"command":"pwd"}}\n```';
    const { client, adapter } = makeClient([
      { content: tool, error: 'DeepSeek 回复已停止，未返回可用正文' },
    ], { maxRetries: 2, delayMs: 0, prompt: '继续' });
    const err = await captureRejection(client.sendContinuation('original'));
    check('complete tool stopped: resolves without retry', err === null, err && err.message);
    check('complete tool stopped: single send', adapter.sent.length === 1, String(adapter.sent.length));
  }

  {
    const { client, adapter } = makeClient([
      { content: '```tool_call\n{"name":"bash"', error: 'DeepSeek 回复已停止，未返回可用正文' },
      { content: ',"arguments":{"command":"pwd"}}\n```', result: 'ok' },
    ], { maxRetries: 1, delayMs: 0, prompt: '继续' });
    const err = await captureRejection(client.sendContinuation('original'));
    check('partial tool stopped: retries', err === null, err && err.message);
    check('partial tool stopped: sends continuation',
      adapter.sent.join('|') === 'original|继续', adapter.sent.join('|'));
  }

  {
    const { client, adapter } = makeClient([
      { content: 'partial', error: 'network blip' },
    ], { maxRetries: 2, delayMs: 0, prompt: '继续' });
    const err = await captureRejection(client.sendContinuation('original'));
    check('non-stopped error: rejects', err && err.message === 'network blip', err && err.message);
    check('non-stopped error: no retry', adapter.sent.length === 1, String(adapter.sent.length));
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
