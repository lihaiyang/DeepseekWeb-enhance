'use strict';

/**
 * Spot tests for the OpenAI-style stream translator. Run with `node`.
 */

const { createTranslator } = require('../src/main/protocol/parse-stream');
const { buildPrompt } = require('../src/main/protocol/build-prompt');

function collect(fn) {
  const out = [];
  const t = createTranslator({ id: 'test', model: 'm', emit: (c) => out.push(c) });
  fn(t);
  return out;
}

function deltaContent(chunks) {
  return chunks
    .map(c => c.choices[0].delta.content)
    .filter(x => typeof x === 'string')
    .join('');
}

function toolCalls(chunks) {
  const map = new Map();
  for (const c of chunks) {
    const tcs = c.choices[0].delta.tool_calls;
    if (!tcs) continue;
    for (const tc of tcs) {
      if (!map.has(tc.index)) map.set(tc.index, { id: null, name: '', arguments: '' });
      const slot = map.get(tc.index);
      if (tc.id) slot.id = tc.id;
      if (tc.function) {
        if (tc.function.name) slot.name = tc.function.name;
        if (typeof tc.function.arguments === 'string') slot.arguments += tc.function.arguments;
      }
    }
  }
  return Array.from(map.values());
}

function finishReason(chunks) {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const fr = chunks[i].choices[0].finish_reason;
    if (fr) return fr;
  }
  return null;
}

let pass = 0;
let fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (info ? ' — ' + info : '')); }
}

// 1. Plain content, no tool call.
{
  const chunks = collect(t => {
    t.pushContent('Hello ');
    t.pushContent('world');
    t.end();
  });
  check('plain content stream', deltaContent(chunks) === 'Hello world');
  check('plain content finish_reason', finishReason(chunks) === 'stop');
  check('plain content no tool_calls', toolCalls(chunks).length === 0);
}

// 2. Tool call delivered in one shot.
{
  const chunks = collect(t => {
    t.pushContent('要列出文件。\n```tool_call\n{"name":"ls","arguments":{"path":"."}}\n```');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('one-shot tool: content preserved', deltaContent(chunks) === '要列出文件。');
  check('one-shot tool: count', tcs.length === 1);
  check('one-shot tool: name', tcs[0] && tcs[0].name === 'ls');
  check('one-shot tool: args', tcs[0] && tcs[0].arguments === '{"path":"."}');
  check('one-shot tool: finish', finishReason(chunks) === 'tool_calls');
}

// 3. Tool call split across many tiny deltas (worst case).
{
  const blob = 'I will run a command.\n```tool_call\n{"name":"bash","arguments":{"cmd":"ls -la"}}\n```';
  const chunks = collect(t => {
    for (const ch of blob) t.pushContent(ch);
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('chunked tool: content', deltaContent(chunks) === 'I will run a command.');
  check('chunked tool: name', tcs.length === 1 && tcs[0].name === 'bash');
  check('chunked tool: args', tcs.length === 1 && tcs[0].arguments === '{"cmd":"ls -la"}');
  check('chunked tool: finish', finishReason(chunks) === 'tool_calls');
}

// 4. Fake fence (looks like fence but inside content, not at line start) must NOT match.
{
  const chunks = collect(t => {
    t.pushContent('See example: foo```tool_call\\nshould be ignored');
    t.end();
  });
  check('inline-not-line-start ignored',
    deltaContent(chunks) === 'See example: foo```tool_call\\nshould be ignored',
    JSON.stringify(deltaContent(chunks)));
  check('inline-not-line-start no tools', toolCalls(chunks).length === 0);
}

// 5. Malformed JSON in tool block surfaces as content rather than vanishing.
{
  const chunks = collect(t => {
    t.pushContent('try this\n```tool_call\nnot-valid-json\n```');
    t.end();
  });
  check('malformed surfaces back', deltaContent(chunks).indexOf('not-valid-json') !== -1);
  check('malformed → finish stop', finishReason(chunks) === 'stop');
}

// 6. Reasoning stream is forwarded separately.
{
  const chunks = collect(t => {
    t.pushReasoning('hm... ');
    t.pushReasoning('thinking');
    t.pushContent('answer');
    t.end();
  });
  const reasoning = chunks
    .map(c => c.choices[0].delta.reasoning_content)
    .filter(x => typeof x === 'string').join('');
  check('reasoning forwarded', reasoning === 'hm... thinking');
  check('content forwarded alongside', deltaContent(chunks) === 'answer');
}

// 7. Multiple tool calls in sequence (rare but should not corrupt state).
{
  const chunks = collect(t => {
    t.pushContent('一步一步：\n```tool_call\n{"name":"a","arguments":{}}\n```\n```tool_call\n{"name":"b","arguments":{}}\n```');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('multi tool count', tcs.length === 2);
  check('multi tool names', tcs[0] && tcs[0].name === 'a' && tcs[1] && tcs[1].name === 'b');
  check('multi tool finish', finishReason(chunks) === 'tool_calls');
}

// 8. buildPrompt sanity: messages + tools roundtrip into a string with the
// promised structure.
{
  const prompt = buildPrompt({
    messages: [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'list files' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'ls', arguments: '{"path":"."}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' },
      { role: 'user', content: 'what next?' }
    ],
    tools: [
      { type: 'function', function: { name: 'ls', description: 'list a dir', parameters: { type: 'object', properties: { path: { type: 'string', description: 'dir' } }, required: ['path'] } } }
    ]
  });
  check('prompt has system header', prompt.indexOf('[系统]') !== -1);
  check('prompt has tool list', prompt.indexOf('### ls') !== -1);
  check('prompt has tool_call fence example', prompt.indexOf('```tool_call') !== -1);
  check('prompt has past tool_call replay', prompt.indexOf('"name":"ls"') !== -1);
  check('prompt has tool result', prompt.indexOf('[工具结果 id=call_1]') !== -1);
  check('prompt ends with assistant cue', /\[助手\]\s*$/.test(prompt));
}

// 9. buildPrompt handles OpenAI array-style content (pi / pi-ai sends this).
{
  const prompt = buildPrompt({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys instructions' }] },
      { role: 'user',   content: [{ type: 'text', text: '你好呀' }] },
    ],
    tools: [],
  });
  check('array content: system text preserved', prompt.indexOf('sys instructions') !== -1);
  check('array content: user text preserved',   prompt.indexOf('你好呀') !== -1);
  check('array content: user header present',   prompt.indexOf('[用户]\n你好呀') !== -1);
}

// 10. buildPrompt handles mixed array parts (text + image_url) gracefully.
{
  const prompt = buildPrompt({
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'describe this:' },
        { type: 'image_url', image_url: { url: 'http://x' } },
      ] },
    ],
    tools: [],
  });
  check('mixed content: text kept', prompt.indexOf('describe this:') !== -1);
  check('mixed content: image placeholder', prompt.indexOf('[image]') !== -1);
}

// 11. Salvage: model writes {"write": {...}} instead of {"name":"write","arguments":{...}}
{
  const chunks = collect(t => {
    t.pushContent('我来写文件。\n```tool_call\n{"write": {"path": "/tmp/a", "content": "hi"}}\n```');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('salvage tool-as-top-key: count', tcs.length === 1);
  check('salvage tool-as-top-key: name', tcs.length === 1 && tcs[0].name === 'write');
  check('salvage tool-as-top-key: args', tcs.length === 1 && tcs[0].arguments === '{"path":"/tmp/a","content":"hi"}');
  check('salvage tool-as-top-key: finish', finishReason(chunks) === 'tool_calls');
}

// 12. Salvage: model puts args flat alongside name.
{
  const chunks = collect(t => {
    t.pushContent('```tool_call\n{"name":"read","path":"x.js","offset":10}\n```');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('salvage flat-args: name', tcs.length === 1 && tcs[0].name === 'read');
  check('salvage flat-args: args has path', tcs.length === 1 && tcs[0].arguments.indexOf('"path":"x.js"') !== -1);
  check('salvage flat-args: args has offset', tcs.length === 1 && tcs[0].arguments.indexOf('"offset":10') !== -1);
}

// 13. Trailing junk after closing fence (model appends "}}" or commentary)
// should not break parsing — fence already closed cleanly.
{
  const chunks = collect(t => {
    t.pushContent('```tool_call\n{"name": "ls", "arguments": {}}\n```\n好的我已经调用了。');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('trailing junk: tool still parsed', tcs.length === 1 && tcs[0].name === 'ls');
  check('trailing junk: finish_reason tool_calls', finishReason(chunks) === 'tool_calls');
  check('trailing junk: trailing text reaches content', deltaContent(chunks).indexOf('好的我已经调用了。') !== -1);
}

// 14. Hallucination cutoff: model fabricates a [工具结果] block after the
// fence — everything from that marker onward must be dropped.
{
  const chunks = collect(t => {
    t.pushContent('我来写文件。\n```tool_call\n{"name":"write","arguments":{"path":"/tmp/a","content":"x"}}\n```\n[工具结果 id=call_x] Successfully wrote\n\n[助手]文件已创建。');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('hallucination: tool_call still parsed', tcs.length === 1 && tcs[0].name === 'write');
  check('hallucination: finish_reason tool_calls', finishReason(chunks) === 'tool_calls');
  const content = deltaContent(chunks);
  check('hallucination: opener kept', content.indexOf('我来写文件。') !== -1);
  check('hallucination: fake tool result dropped', content.indexOf('Successfully wrote') === -1);
  check('hallucination: fake assistant line dropped', content.indexOf('文件已创建') === -1);
  check('hallucination: marker itself dropped', content.indexOf('[工具结果') === -1);
}

// 15. Hallucinated `[助手]` block without any tool_call (pure script-mode
// continuation). Should also be cut off.
{
  const chunks = collect(t => {
    t.pushContent('好的，我会处理。\n[助手]接下来我做的事是…');
    t.end();
  });
  check('helper-only hallucination: opener kept', deltaContent(chunks).indexOf('好的，我会处理。') !== -1);
  check('helper-only hallucination: fake follow-up dropped', deltaContent(chunks).indexOf('接下来') === -1);
  check('helper-only hallucination: finish_reason stop', finishReason(chunks) === 'stop');
}

// 16. Stop sequence split across two deltas — buffer must hold the
// "\n[工" prefix until the rest arrives, then cut off.
{
  const chunks = collect(t => {
    t.pushContent('hello\n[工');
    t.pushContent('具结果 id=x] not real');
    t.end();
  });
  check('split stop: prefix held & cut', deltaContent(chunks) === 'hello');
  check('split stop: hallucination not leaked', deltaContent(chunks).indexOf('not real') === -1);
}

// 17. Inline `[helper]` text inside normal content (not at line start) must
// NOT trigger truncation — it's a real character sequence the user might
// want to see.
{
  const chunks = collect(t => {
    t.pushContent('See note [助手] is just a label here, not a marker.');
    t.end();
  });
  check('inline marker preserved', deltaContent(chunks).indexOf('[助手]') !== -1);
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
