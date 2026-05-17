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

// 7. Multiple tool_call fences in a single response: only the first is
// emitted, the rest are silently dropped by the parser cap.
{
  const chunks = collect(t => {
    t.pushContent('一步一步：\n```tool_call\n{"name":"a","arguments":{}}\n```\n```tool_call\n{"name":"b","arguments":{}}\n```');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('cap: only first tool call kept', tcs.length === 1);
  check('cap: first tool name preserved', tcs[0] && tcs[0].name === 'a');
  check('cap: finish_reason still tool_calls', finishReason(chunks) === 'tool_calls');
  check('cap: second fence not leaked into content',
    deltaContent(chunks).indexOf('"name":"b"') === -1);
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
  check('prompt ends with last dialog message (no trailing [助手] cue)',
    /\[用户\]\nwhat next\?\s*$/.test(prompt));
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
// is silently dropped by the cap — protocol rule 5 forbids any post-fence
// content, and the parser enforces it.
{
  const chunks = collect(t => {
    t.pushContent('```tool_call\n{"name": "ls", "arguments": {}}\n```\n好的我已经调用了。');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('trailing junk: tool still parsed', tcs.length === 1 && tcs[0].name === 'ls');
  check('trailing junk: finish_reason tool_calls', finishReason(chunks) === 'tool_calls');
  check('trailing junk: trailing text dropped', deltaContent(chunks).indexOf('好的我已经调用了。') === -1);
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

// 18. Custom prompt template substitutes {{tools}} with the rendered tool
// list and replaces the default block entirely.
{
  const prompt = buildPrompt({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'echo', description: 'd', parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } } }],
  }, {
    template: 'MY CUSTOM HEADER\n\n{{tools}}\n\nMY CUSTOM FOOTER',
  });
  check('custom template: header kept', prompt.indexOf('MY CUSTOM HEADER') !== -1);
  check('custom template: footer kept', prompt.indexOf('MY CUSTOM FOOTER') !== -1);
  check('custom template: tools substituted', prompt.indexOf('### echo') !== -1);
  check('custom template: default block absent', prompt.indexOf('硬性规则') === -1);
}

// 19. Empty tools[] with template using {{tools}}: placeholder collapses
// gracefully, no double blank lines.
{
  const prompt = buildPrompt({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  }, {
    template: 'top\n\n{{tools}}\n\nbottom',
  });
  check('empty tools: placeholder dropped', prompt.indexOf('{{tools}}') === -1);
  check('empty tools: top kept', prompt.indexOf('top') !== -1);
  check('empty tools: bottom kept', prompt.indexOf('bottom') !== -1);
}

// 20. {{system}} placeholder substitutes pi's system prompt at the chosen
// position and disables the auto-prepend, so the user can inject content
// before it.
{
  const prompt = buildPrompt({
    messages: [
      { role: 'system', content: 'PI-SYS' },
      { role: 'user', content: 'hi' },
    ],
    tools: [],
  }, {
    template: 'BEFORE-SYS\n\n{{system}}\n\nAFTER-SYS',
  });
  check('system placeholder: pi system rendered',
    prompt.indexOf('[系统]\nPI-SYS') !== -1);
  check('system placeholder: user content placed before pi system',
    prompt.indexOf('BEFORE-SYS') < prompt.indexOf('[系统]\nPI-SYS'));
  check('system placeholder: user content placed after pi system too',
    prompt.indexOf('[系统]\nPI-SYS') < prompt.indexOf('AFTER-SYS'));
  check('system placeholder: no duplicate auto-prepend',
    (prompt.match(/\[系统\]\nPI-SYS/g) || []).length === 1);
  check('system placeholder: literal token replaced',
    prompt.indexOf('{{system}}') === -1);
}

// 21. Template without {{system}}: falls back to legacy behavior — pi's
// system is prepended before the template.
{
  const prompt = buildPrompt({
    messages: [
      { role: 'system', content: 'PI-SYS' },
      { role: 'user', content: 'hi' },
    ],
    tools: [],
  }, {
    template: 'MY HEADER',
  });
  check('no system placeholder: pi system still present',
    prompt.indexOf('[系统]\nPI-SYS') !== -1);
  check('no system placeholder: pi system prepended before template',
    prompt.indexOf('[系统]\nPI-SYS') < prompt.indexOf('MY HEADER'));
}

// 22. {{system}} placeholder with NO system messages collapses cleanly.
{
  const prompt = buildPrompt({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  }, {
    template: 'top\n\n{{system}}\n\nbottom',
  });
  check('empty system: placeholder dropped',
    prompt.indexOf('{{system}}') === -1);
  check('empty system: top kept', prompt.indexOf('top') !== -1);
  check('empty system: bottom kept', prompt.indexOf('bottom') !== -1);
  check('empty system: no stray [系统] header',
    prompt.indexOf('[系统]') === -1);
}

// 23. Multiple system messages all flow into one {{system}} expansion.
{
  const prompt = buildPrompt({
    messages: [
      { role: 'system', content: 'sys-a' },
      { role: 'developer', content: 'dev-b' },
      { role: 'user', content: 'hi' },
    ],
    tools: [],
  }, {
    template: 'X\n\n{{system}}\n\nY',
  });
  check('multi system: both sys-a and dev-b present',
    prompt.indexOf('sys-a') !== -1 && prompt.indexOf('dev-b') !== -1);
  check('multi system: system block sits between X and Y',
    prompt.indexOf('X') < prompt.indexOf('sys-a') &&
    prompt.indexOf('dev-b') < prompt.indexOf('Y'));
}

// 24. Tool call followed by narration: narration is dropped (no second
// tool_call permitted, and post-fence text is forbidden by protocol).
{
  const chunks = collect(t => {
    t.pushContent('```tool_call\n{"name":"ls","arguments":{}}\n```\n好的，我接下来会读取每个文件并总结。');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('cap+narration: tool parsed', tcs.length === 1 && tcs[0].name === 'ls');
  check('cap+narration: trailing narration dropped',
    deltaContent(chunks).indexOf('接下来会读取') === -1);
  check('cap+narration: finish_reason tool_calls', finishReason(chunks) === 'tool_calls');
}

// 25. Malformed first fence does NOT consume the cap: a subsequent valid
// fence in the same turn still parses.
{
  const chunks = collect(t => {
    t.pushContent('```tool_call\nnot-valid-json\n```\n再试一次：\n```tool_call\n{"name":"read","arguments":{"path":"x"}}\n```');
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('cap+salvage: malformed surfaced as content',
    deltaContent(chunks).indexOf('not-valid-json') !== -1);
  check('cap+salvage: valid fence still parsed', tcs.length === 1 && tcs[0].name === 'read');
  check('cap+salvage: finish_reason tool_calls', finishReason(chunks) === 'tool_calls');
}

// 26. Tool call across many tiny deltas + trailing second fence: cap holds
// even when chunks are pathologically small.
{
  const blob = '```tool_call\n{"name":"a","arguments":{}}\n```\n```tool_call\n{"name":"b","arguments":{}}\n```';
  const chunks = collect(t => {
    for (const ch of blob) t.pushContent(ch);
    t.end();
  });
  const tcs = toolCalls(chunks);
  check('cap chunked: one tool only', tcs.length === 1);
  check('cap chunked: first wins', tcs[0] && tcs[0].name === 'a');
  check('cap chunked: second not in content', deltaContent(chunks).indexOf('"name":"b"') === -1);
}

// 27. {{messages}} placeholder lets the user inject custom prompt content
// AFTER the dialog history, disables auto-append, and removes the need for
// the legacy [助手] cue at the end.
{
  const prompt = buildPrompt({
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ],
    tools: [],
  }, {
    template: 'HEADER\n\n{{messages}}\n\nAFTER-MSG-CUE',
  });
  check('messages placeholder: header kept', prompt.indexOf('HEADER') !== -1);
  check('messages placeholder: first user content placed',
    prompt.indexOf('[用户]\nfirst') !== -1);
  check('messages placeholder: assistant content placed',
    prompt.indexOf('[助手]\nok') !== -1);
  check('messages placeholder: second user content placed',
    prompt.indexOf('[用户]\nsecond') !== -1);
  check('messages placeholder: AFTER cue sits past dialog',
    prompt.indexOf('[用户]\nsecond') < prompt.indexOf('AFTER-MSG-CUE'));
  check('messages placeholder: header before dialog',
    prompt.indexOf('HEADER') < prompt.indexOf('[用户]\nfirst'));
  check('messages placeholder: no duplicate auto-append',
    (prompt.match(/\[用户\]\nfirst/g) || []).length === 1);
  check('messages placeholder: literal token replaced',
    prompt.indexOf('{{messages}}') === -1);
  check('messages placeholder: no trailing [助手] cue',
    !/\[助手\]\s*$/.test(prompt));
}

// 28. Template without {{messages}}: falls back to legacy behavior — dialog
// is appended after the template (and still no trailing [助手] cue, that
// piece was removed unconditionally).
{
  const prompt = buildPrompt({
    messages: [
      { role: 'user', content: 'hello' },
    ],
    tools: [],
  }, {
    template: 'ONLY HEADER',
  });
  check('no messages placeholder: header present',
    prompt.indexOf('ONLY HEADER') !== -1);
  check('no messages placeholder: dialog appended',
    prompt.indexOf('[用户]\nhello') !== -1);
  check('no messages placeholder: header precedes dialog',
    prompt.indexOf('ONLY HEADER') < prompt.indexOf('[用户]\nhello'));
  check('no messages placeholder: prompt ends with dialog, not [助手]',
    /\[用户\]\nhello\s*$/.test(prompt));
}

// 29. {{messages}} placeholder with NO dialog messages collapses cleanly.
{
  const prompt = buildPrompt({
    messages: [{ role: 'system', content: 'sys' }],
    tools: [],
  }, {
    template: 'top\n\n{{messages}}\n\nbottom',
  });
  check('empty messages: placeholder dropped',
    prompt.indexOf('{{messages}}') === -1);
  check('empty messages: top kept', prompt.indexOf('top') !== -1);
  check('empty messages: bottom kept', prompt.indexOf('bottom') !== -1);
  check('empty messages: no stray [用户] header',
    prompt.indexOf('[用户]') === -1);
}

// 30. Default template no longer contains the legacy "输出格式硬约束" /
// trailing [助手] cue, but still produces a complete tool-call protocol.
{
  const prompt = buildPrompt({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
  });
  check('default: no 输出格式硬约束 section',
    prompt.indexOf('输出格式硬约束') === -1);
  check('default: no trailing [助手] cue',
    !/\[助手\]\s*$/.test(prompt));
  check('default: tool-call protocol still present',
    prompt.indexOf('工具调用协议') !== -1);
  check('default: hard rules still present',
    prompt.indexOf('硬性规则') !== -1);
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
