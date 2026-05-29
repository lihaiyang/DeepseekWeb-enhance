'use strict';

/**
 * DeepSeek 文本流 → OpenAI chat.completion.chunk SSE
 *
 * DeepSeek 网页给我们的是分两路的纯文本：reasoning（思考）和 content（正文）。
 * 我们把 reasoning 转成 OpenAI 扩展字段 `delta.reasoning_content`，content
 * 则扫描出约定的工具调用代码块并切换成 `delta.tool_calls`，其余作为
 * `delta.content` 流式输出。
 *
 * 工具调用块严格要求"行首单独成行"：
 *
 *   ```tool_call
 *   {"name":"...","arguments":{...}}
 *   ```
 *
 * 流式 buffer 处理时，尾部可能是 fence 开头的不完整前缀，需要保留到下一次
 * delta 才能判定。
 */

const STATE_IDLE = 0;
const STATE_TOOL_CALL = 1;
const STATE_TRUNCATED = 2;

const { TOOL_CALL_FENCE_OPEN, TOOL_CALL_FENCE_CLOSE } = require('./build-prompt');

// Alternative fence patterns the model might use instead of ```tool_call.
// We detect any of these, parse the JSON content, and validate it really
// is a tool call before treating it as one.
const ALT_TOOL_FENCES = ['```tool_call', '```toolcall'];

// Line-prefix tokens that, if produced by the model, mean it has started
// hallucinating the next turn of the dialog script (a `<|工具|>` block,
// the next `<|助手|>` line, etc). When we hit one we cut the stream off
// at that point and discard everything that follows.
const HALLUCINATION_STOP_SEQUENCES = [
  '<|工具|>',
  '<|助手|>',
  '<|用户|>',
  '<|系统|>',
  '<|开发者|>',
  '<|约束|>',
  '<|工具定义|>',
  '<|工具协议|>',
  '<|约束结束|>',
  '<|系统结束|>',
  '<|用户结束|>',
  '<|助手结束|>',
  '<|开发者结束|>',
  '<|工具定义结束|>',
  '<|工具协议结束|>',
  '<|工具结果结束|>',
];

function generateId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Try to parse `raw` as JSON, applying common repairs on failure.
 * Returns the parsed object, or null if all repairs fail.
 */
function repairJson(raw) {
  // Attempt 1: raw parse
  try { return JSON.parse(raw); } catch (_) {}

  let fixed = raw;

  // Attempt 2: strip trailing commas before } or ]
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(fixed); } catch (_) {}

  // Attempt 3: replace curly/smart quotes with straight double quotes
  var CQ_LEFT = String.fromCharCode(0x201C);
  var CQ_RIGHT = String.fromCharCode(0x201D);
  fixed = fixed.split(CQ_LEFT).join('"').split(CQ_RIGHT).join('"');
  try { return JSON.parse(fixed); } catch (_) {}

  // Attempt 4: fix unbalanced braces / brackets.
  // The model sometimes cuts off trailing } or ], leaving the JSON
  // unparseable.  We count openings vs closings (ignoring character
  // inside string literals for the common shallow-nesting case) and
  // append the missing closings at the end.
  {
    var openBraces = 0, closeBraces = 0;
    var openBrackets = 0, closeBrackets = 0;
    var inString = false, prevChar = '';
    for (var i = 0; i < fixed.length; i++) {
      var ch = fixed[i];
      // Toggle inString only on unescaped double-quotes
      if (ch === '"' && prevChar !== '\\\\') { inString = !inString; }
      else if (!inString) {
        if (ch === '{')  openBraces++;
        else if (ch === '}') closeBraces++;
        else if (ch === '[') openBrackets++;
        else if (ch === ']') closeBrackets++;
      }
      prevChar = ch;
    }
    if (openBraces > closeBraces || openBrackets > closeBrackets) {
      for (var b = 0; b < openBraces - closeBraces; b++) fixed += '}';
      for (var a = 0; a < openBrackets - closeBrackets; a++) fixed += ']';
      try { return JSON.parse(fixed); } catch (_) {}
    }
  }

  return null;
}

function createTranslator(opts) {
  const id = (opts && opts.id) || generateId('chatcmpl');
  const model = (opts && opts.model) || 'deepseek-via-web';
  const fenceOpen = (opts && opts.fenceOpen) || TOOL_CALL_FENCE_OPEN;
  const fenceClose = (opts && opts.fenceClose) || TOOL_CALL_FENCE_CLOSE;
  const emit = opts.emit;
  if (typeof emit !== 'function') {
    throw new Error('createTranslator: opts.emit (function) required');
  }

  const created = Math.floor(Date.now() / 1000);
  let state = STATE_IDLE;
  let buffer = '';
  let toolBuffer = '';
  let toolCallIndex = 0;
  let toolCallsEmitted = false;
  let pendingPreFenceContent = '';
  let matchedFenceOpen = fenceOpen;
  let started = false;
  let ended = false;

  function chunk(delta, finishReason) {
    return {
      id: id,
      object: 'chat.completion.chunk',
      created: created,
      model: model,
      choices: [{
        index: 0,
        delta: delta || {},
        finish_reason: finishReason == null ? null : finishReason
      }]
    };
  }

  function emitContent(text) {
    if (!text) return;
    emit(chunk({ content: text }));
  }

  function emitReasoning(text) {
    if (!text) return;
    emit(chunk({ reasoning_content: text }));
  }

  function ensureStarted() {
    if (started) return;
    started = true;
    emit(chunk({ role: 'assistant', content: '' }));
  }

  /**
   * Find a fence string at a line start (preceded by \n or buffer start)
   * and followed by \n/\r (i.e. the fence occupies its own line).  Trailing
   * whitespace after the fence identifier (e.g. "```tool_call ") is skipped
   * so the model's occasional extra spaces don't break detection.
   *
   * If atEndOk is true, also accept the fence at the very end of buf
   * (no trailing newline) — used when the stream has already ended.
   * Returns -1 if no qualifying fence is found.
   */
  function findFenceLine(buf, fence, atEndOk) {
    let from = 0;
    while (from <= buf.length - fence.length) {
      const idx = buf.indexOf(fence, from);
      if (idx === -1) return -1;
      const atLineStart = idx === 0 || buf[idx - 1] === '\n';
      if (!atLineStart) { from = idx + 1; continue; }
      // Skip trailing whitespace after the fence identifier
      let after = idx + fence.length;
      while (after < buf.length && (buf[after] === ' ' || buf[after] === '\t')) {
        after++;
      }
      const next = buf[after];
      const completeLine =
        next === '\n' ||
        next === '\r' ||
        (atEndOk && next === undefined);
      if (completeLine) return idx;
      from = idx + 1;
    }
    return -1;
  }

  /**
   * Find the earliest occurrence of any hallucination stop-sequence at a
   * line start (preceded by \n or buffer start). Returns -1 if none found.
   */
  function findStopSequence(buf) {
    let best = -1;
    for (const seq of HALLUCINATION_STOP_SEQUENCES) {
      let from = 0;
      while (from <= buf.length - seq.length) {
        const idx = buf.indexOf(seq, from);
        if (idx === -1) break;
        const atLineStart = idx === 0 || buf[idx - 1] === '\n';
        if (atLineStart) {
          if (best === -1 || idx < best) best = idx;
          break;
        }
        from = idx + 1;
      }
    }
    return best;
  }

  /**
   * Is `tail` a strict prefix (or full match shorter than the next char)
   * of any marker we need to detect — any tool-call fence variant or a
   * hallucination stop sequence?
   */
  function tailIsMarkerPrefix(tail) {
    if (tail.length === 0) return false;
    for (const f of ALT_TOOL_FENCES) {
      if (tail.length <= f.length && f.startsWith(tail)) return true;
    }
    for (const seq of HALLUCINATION_STOP_SEQUENCES) {
      if (tail.length <= seq.length && seq.startsWith(tail)) return true;
    }
    return false;
  }

  /**
   * In IDLE state we may have a partial marker prefix sitting at the
   * buffer tail. Return the highest index we can safely flush as content
   * without risking emitting half of a marker.
   */
  function safeIdleEmitEnd() {
    const lastNl = buffer.lastIndexOf('\n');
    const tailStart = lastNl === -1 ? 0 : lastNl + 1;
    const tail = buffer.slice(tailStart);
    if (tailIsMarkerPrefix(tail)) {
      return lastNl === -1 ? 0 : lastNl;
    }
    if (tail.length === 0 && lastNl === buffer.length - 1 && lastNl !== -1) {
      return lastNl;
    }
    if (buffer.endsWith('\r')) return buffer.length - 1;
    return buffer.length;
  }

  function flushToolBuffer() {
    const raw = toolBuffer.trim();
    const currentFence = matchedFenceOpen;
    toolBuffer = '';
    matchedFenceOpen = fenceOpen;
    if (!raw) return;

    // Parse with repair fallback
    let parsed = repairJson(raw);
    if (!parsed) {
      if (pendingPreFenceContent) {
        emitContent(pendingPreFenceContent);
        pendingPreFenceContent = '';
      }
      emitContent('\n' + currentFence + '\n' + raw + '\n' + fenceClose + '\n');
      return;
    }

    // Salvage common shape mistakes from the model (run BEFORE validation):
    //   {"write": {"path": "..."}}        →  {name: "write", arguments: {...}}
    //   {"name": "write", "path": "..."}  →  {name: "write", arguments: {path: ...}}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.name !== 'string') {
        const keys = Object.keys(parsed);
        if (keys.length === 1) {
          const k = keys[0];
          const v = parsed[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            parsed = { name: k, arguments: v };
          }
        }
      } else if (parsed.arguments === undefined) {
        const flat = Object.assign({}, parsed);
        delete flat.name;
        delete flat.id;
        if (Object.keys(flat).length > 0) {
          parsed = { name: parsed.name, arguments: flat, id: parsed.id };
        }
      }
    }

    // Validate AFTER salvage: must have a non-empty "name"
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        typeof parsed.name !== 'string' || !parsed.name.trim()) {
      if (pendingPreFenceContent) {
        emitContent(pendingPreFenceContent);
        pendingPreFenceContent = '';
      }
      emitContent('\n' + currentFence + '\n' + raw + '\n' + fenceClose + '\n');
      return;
    }

    const name = typeof parsed.name === 'string' ? parsed.name : '';
    let args = parsed.arguments;
    if (args == null) args = {};

    // If the model wrote arguments as a plain string (e.g. "ls" instead of
    // {"command":"ls"}), try to parse it as JSON.  If it fails, the args
    // are irrecoverable — drop the tool call and emit the raw text as
    // content so the user can see what the model actually produced.
    if (typeof args === 'string') {
      try { args = JSON.parse(args); }
      catch (_) {
        if (pendingPreFenceContent) {
          emitContent(pendingPreFenceContent);
          pendingPreFenceContent = '';
        }
        emitContent('\n' + currentFence + '\n' + raw + '\n' + fenceClose + '\n');
        return;
      }
    }
    if (typeof args !== 'string') {
      try { args = JSON.stringify(args); } catch (_) { args = '{}'; }
    }

    const callId = (typeof parsed.id === 'string' && parsed.id) || generateId('call');

    emit(chunk({
      tool_calls: [{
        index: toolCallIndex,
        id: callId,
        type: 'function',
        function: { name: name, arguments: '' }
      }]
    }));
    if (args) {
      emit(chunk({
        tool_calls: [{
          index: toolCallIndex,
          function: { arguments: args }
        }]
      }));
    }
    toolCallIndex++;
    toolCallsEmitted = true;
    pendingPreFenceContent = '';
    matchedFenceOpen = fenceOpen;
  }

  function drainIdle(isFinal) {
    while (state === STATE_IDLE) {
      // Find the earliest tool-call fence among all supported variants.
      let fenceIdx = -1;
      matchedFenceOpen = fenceOpen;
      for (const f of ALT_TOOL_FENCES) {
        const idx = findFenceLine(buffer, f, false);
        if (idx !== -1 && (fenceIdx === -1 || idx < fenceIdx)) {
          fenceIdx = idx;
          matchedFenceOpen = f;
        }
      }
      const stopIdx = findStopSequence(buffer);
      let useStop = false;
      let nextIdx = -1;
      if (fenceIdx !== -1 && stopIdx !== -1) {
        if (stopIdx <= fenceIdx) { useStop = true; nextIdx = stopIdx; }
        else { nextIdx = fenceIdx; }
      } else if (stopIdx !== -1) {
        useStop = true; nextIdx = stopIdx;
      } else if (fenceIdx !== -1) {
        nextIdx = fenceIdx;
      }

      if (nextIdx === -1) {
        const end = isFinal ? buffer.length : safeIdleEmitEnd();
        if (end > 0) {
          emitContent(buffer.slice(0, end));
          buffer = buffer.slice(end);
        }
        return;
      }

      // Text before the marker, stripping the separating \n.
      let before = buffer.slice(0, nextIdx);
      if (before.endsWith('\n')) before = before.slice(0, -1);

      if (useStop) {
        emitContent(before);
        buffer = '';
        state = STATE_TRUNCATED;
        return;
      }

      // Tool-call fence — hold back pre-fence text
      if (before) pendingPreFenceContent = before;
      let consumed = fenceIdx + matchedFenceOpen.length;
      // Skip trailing whitespace we already tolerated in findFenceLine
      while (consumed < buffer.length && (buffer[consumed] === ' ' || buffer[consumed] === '\t')) {
        consumed++;
      }
      if (buffer[consumed] === '\r') consumed++;
      if (buffer[consumed] === '\n') consumed++;
      buffer = buffer.slice(consumed);
      state = STATE_TOOL_CALL;
    }
  }

  function drainToolCall(isFinal) {
    while (state === STATE_TOOL_CALL) {
      const idx = findFenceLine(buffer, fenceClose, isFinal);
      if (idx === -1) {
        if (isFinal) {
          toolBuffer += buffer;
          buffer = '';
          flushToolBuffer();
          state = toolCallsEmitted ? STATE_TRUNCATED : STATE_IDLE;
        }
        return;
      }
      toolBuffer += buffer.slice(0, idx);
      let consumed = idx + fenceClose.length;
      if (buffer[consumed] === '\r') consumed++;
      if (buffer[consumed] === '\n') consumed++;
      buffer = buffer.slice(consumed);
      flushToolBuffer();
      if (toolCallsEmitted) {
        buffer = '';
        state = STATE_TRUNCATED;
        return;
      }
      state = STATE_IDLE;
    }
  }

  return {
    pushReasoning(delta) {
      if (ended || state === STATE_TRUNCATED) return;
      if (typeof delta !== 'string' || !delta) return;
      ensureStarted();
      emitReasoning(delta);
    },
    pushContent(delta) {
      if (ended) return;
      if (state === STATE_TRUNCATED) return;
      if (typeof delta !== 'string' || !delta) return;
      ensureStarted();
      buffer += delta;
      drainIdle(false);
      drainToolCall(false);
    },
    end() {
      if (ended) return;
      ended = true;
      ensureStarted();
      if (state !== STATE_TRUNCATED) {
        drainIdle(true);
        drainToolCall(true);
      }
      if (pendingPreFenceContent) {
        emitContent(pendingPreFenceContent);
        pendingPreFenceContent = '';
      }
      emit(chunk({}, toolCallsEmitted ? 'tool_calls' : 'stop'));
    },
    fail(message) {
      if (ended) return;
      ended = true;
      ensureStarted();
      emitContent('\n[stream error: ' + (message || 'unknown') + ']');
      emit(chunk({}, 'stop'));
    },
    getId() { return id; }
  };
}

module.exports = { createTranslator };