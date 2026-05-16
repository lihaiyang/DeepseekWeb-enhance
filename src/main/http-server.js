'use strict';

/**
 * HTTP server exposing an OpenAI-compatible /v1/chat/completions endpoint
 * that pipes through LlmBridge into the DeepSeek webview.
 *
 * Bound to 127.0.0.1 with a random port (so we never collide with another
 * dev's local server). The chosen port is written into pi's models.json
 * at startup.
 */

const http = require('http');

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body !== undefined) res.end(body);
  else res.end();
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  send(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  }, body);
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > limitBytes) {
        aborted = true;
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('invalid JSON body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

/**
 * Build a non-streaming response by collecting all chunks and merging them
 * into a single OpenAI ChatCompletion object.
 */
function aggregateChunks(chunks, model) {
  const id = chunks.length ? chunks[0].id : ('chatcmpl-' + Date.now().toString(36));
  let content = '';
  let reasoning = '';
  const toolCallsByIndex = new Map();
  let finishReason = 'stop';

  for (const c of chunks) {
    const choice = c.choices && c.choices[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (typeof d.content === 'string') content += d.content;
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index || 0;
        if (!toolCallsByIndex.has(idx)) {
          toolCallsByIndex.set(idx, {
            index: idx, id: tc.id || ('call_' + idx),
            type: 'function',
            function: { name: '', arguments: '' },
          });
        }
        const slot = toolCallsByIndex.get(idx);
        if (tc.id) slot.id = tc.id;
        if (tc.function) {
          if (tc.function.name) slot.function.name = tc.function.name;
          if (typeof tc.function.arguments === 'string') slot.function.arguments += tc.function.arguments;
        }
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCallsByIndex.size) {
    message.tool_calls = Array.from(toolCallsByIndex.values()).sort((a, b) => a.index - b.index);
    for (const tc of message.tool_calls) delete tc.index;
  }

  return {
    id, object: 'chat.completion', created: nowSeconds(), model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
}

function writeSseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
}

function writeSseChunk(res, chunk) {
  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
}

function writeSseDone(res) {
  res.write('data: [DONE]\n\n');
}

/**
 * @param {object} deps
 * @param {import('./llm-bridge').LlmBridge} deps.bridge
 * @param {function(string,object=)} [deps.log]
 */
function createHttpServer(deps) {
  const bridge = deps.bridge;
  const log = deps.log || (() => {});
  const BODY_LIMIT = 8 * 1024 * 1024; // 8MB cap; pi messages can carry tool output

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      send(res, 204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      return;
    }

    const url = req.url || '/';

    if (req.method === 'GET' && url === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: [{
          id: 'deepseek-via-web',
          object: 'model',
          created: nowSeconds(),
          owned_by: 'ds-agent',
        }],
      });
      return;
    }

    if (req.method === 'GET' && (url === '/healthz' || url === '/')) {
      sendJson(res, 200, { ok: true, ready: bridge.isReady() });
      return;
    }

    if (req.method === 'POST' && url === '/v1/chat/completions') {
      let body;
      try {
        body = await readJsonBody(req, BODY_LIMIT);
      } catch (err) {
        sendJson(res, 400, { error: { message: err.message, type: 'invalid_request_error' } });
        return;
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        sendJson(res, 400, { error: { message: 'messages[] required', type: 'invalid_request_error' } });
        return;
      }

      const wantsStream = body.stream === true;
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.on('close', onClose);

      log('llm:request', {
        stream: wantsStream,
        messages: body.messages.length,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        model: body.model,
      });

      if (wantsStream) {
        writeSseHeaders(res);
        const onChunk = (chunk) => {
          try { writeSseChunk(res, chunk); }
          catch (_) { ac.abort(); }
        };
        try {
          await bridge.request({ body, onChunk, signal: ac.signal });
          writeSseDone(res);
        } catch (err) {
          log('llm:error', { message: err.message });
          // Embed error as a final delta so pi sees a finishing chunk.
          try {
            writeSseChunk(res, {
              id: 'chatcmpl-err-' + Date.now().toString(36),
              object: 'chat.completion.chunk',
              created: nowSeconds(),
              model: body.model || 'deepseek-via-web',
              choices: [{
                index: 0,
                delta: { content: '\n[ds-agent error: ' + err.message + ']' },
                finish_reason: 'stop',
              }],
            });
            writeSseDone(res);
          } catch (_) {}
        } finally {
          req.removeListener('close', onClose);
          try { res.end(); } catch (_) {}
        }
        return;
      }

      // Non-streaming: collect all chunks, then send one merged object.
      const collected = [];
      try {
        await bridge.request({
          body,
          onChunk: (c) => collected.push(c),
          signal: ac.signal,
        });
      } catch (err) {
        req.removeListener('close', onClose);
        sendJson(res, 500, { error: { message: err.message, type: 'server_error' } });
        return;
      }
      req.removeListener('close', onClose);
      sendJson(res, 200, aggregateChunks(collected, body.model || 'deepseek-via-web'));
      return;
    }

    sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  });

  /**
   * @returns {Promise<number>} chosen port
   */
  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const addr = server.address();
        resolve(addr && typeof addr === 'object' ? addr.port : -1);
      });
    });
  }

  function close() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { listen, close, server };
}

module.exports = { createHttpServer };
