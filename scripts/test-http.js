'use strict';

/**
 * End-to-end smoke test for the HTTP server with a faked LlmBridge that
 * synthesises a streamed response containing a tool_call fence.
 */

const http = require('http');
const { createHttpServer } = require('../src/main/http-server');

class FakeBridge {
  constructor(script) {
    this._script = script;
  }
  isReady() { return true; }
  request({ body, onChunk, signal }) {
    return new Promise((resolve, reject) => {
      const created = Math.floor(Date.now() / 1000);
      const id = 'fake-' + Date.now().toString(36);
      const model = body.model || 'deepseek-via-web';
      const send = (delta, finishReason) => onChunk({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finishReason == null ? null : finishReason }],
      });
      const sendUsage = (usage) => onChunk({
        id, object: 'chat.completion.chunk', created, model,
        choices: [],
        usage,
      });
      let i = 0;
      const tick = () => {
        if (signal && signal.aborted) return reject(new Error('aborted'));
        if (i >= this._script.length) return resolve();
        const step = this._script[i++];
        if (step.role) send({ role: 'assistant', content: '' });
        if (step.content !== undefined) send({ content: step.content });
        if (step.tool_call) send({ tool_calls: [step.tool_call] });
        if (step.finish_reason !== undefined) send({}, step.finish_reason);
        if (step.usage) sendUsage(step.usage);
        setImmediate(tick);
      };
      tick();
    });
  }
}

class RejectBridge {
  isReady() { return true; }
  request() {
    return Promise.reject(new Error('DeepSeek 回复已停止，未返回可用正文'));
  }
}

async function fetchSseAll(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(JSON.stringify({
      model: 'deepseek-via-web',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }));
    req.end();
  });
}

async function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (info ? ' — ' + info : '')); }
}

(async () => {
  // SSE streaming with tool_call.
  const bridge = new FakeBridge([
    { role: true },
    { content: 'starting...' },
    { tool_call: { index: 0, id: 'call_1', type: 'function', function: { name: 'ls', arguments: '' } } },
    { tool_call: { index: 0, function: { arguments: '{"path":"."}' } } },
    { finish_reason: 'tool_calls' },
    { usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } },
  ]);
  const server = createHttpServer({ bridge });
  const port = await server.listen();

  const { status, body } = await fetchSseAll(port);
  check('sse status 200', status === 200);
  check('sse contains data: lines', body.indexOf('data: {') !== -1);
  check('sse terminates with [DONE]', body.trim().endsWith('data: [DONE]'));
  check('sse has tool_calls', body.indexOf('"tool_calls"') !== -1);
  check('sse has finish_reason tool_calls', body.indexOf('"tool_calls"') !== -1);
  check('sse has usage chunk', body.indexOf('"usage"') !== -1 && body.indexOf('"prompt_tokens":123') !== -1);

  // Non-streaming: aggregator.
  const r2 = await postJson(port, {
    model: 'deepseek-via-web',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  });
  check('non-stream status 200', r2.status === 200);
  check('non-stream object', r2.json.object === 'chat.completion');
  const msg = r2.json.choices && r2.json.choices[0] && r2.json.choices[0].message;
  check('non-stream message.content is null when tool_calls present', msg && msg.content === null);
  check('non-stream tool_calls collected', msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length === 1);
  check('non-stream tool_calls args aggregated',
    msg && msg.tool_calls[0].function.arguments === '{"path":"."}');
  check('non-stream finish_reason', r2.json.choices[0].finish_reason === 'tool_calls');
  check('non-stream usage aggregated', r2.json.usage && r2.json.usage.total_tokens === 168);

  await server.close();

  // Streaming errors are surfaced as SSE error events, without [DONE].
  const errorServer = createHttpServer({ bridge: new RejectBridge() });
  const errorPort = await errorServer.listen();
  const errStream = await fetchSseAll(errorPort);
  check('sse error status 200', errStream.status === 200);
  check('sse error event emitted', errStream.body.indexOf('"error"') !== -1);
  check('sse error has message', errStream.body.indexOf('DeepSeek 回复已停止') !== -1);
  check('sse error has no DONE', errStream.body.indexOf('[DONE]') === -1);
  const errJson = await postJson(errorPort, {
    model: 'deepseek-via-web',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  });
  check('non-stream error status 500', errJson.status === 500);
  check('non-stream error payload', errJson.json.error && errJson.json.error.message.indexOf('DeepSeek 回复已停止') !== -1);
  await errorServer.close();

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test crashed:', err);
  process.exit(1);
});
