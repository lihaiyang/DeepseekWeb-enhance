'use strict';

/**
 * OpenAI Chat Completions → 单条 DeepSeek prompt
 *
 * DeepSeek 网页只能接收一条 prompt 文本，没有 messages 数组、没有 tool_calls
 * 字段。这里把标准 OpenAI 请求拼成一段自包含文本：系统提示 + 工具列表 +
 * 消息历史，并约定一种工具调用 / 工具结果的纯文本格式让模型遵循。
 *
 * 用户可以覆盖默认的"注入模板"（工具协议规则 + 工具清单）。模板里支持四个占位符：
 *   - `{{system}}`：替换为 pi 自带的 system / developer 消息（每条会被格式化
 *     为 `<|系统|>\n<content>` 块）。模板里出现该占位符时，pi 的
 *     system 不再被自动前置 —— 由模板决定它出现在哪里；模板里没有该占位符时，
 *     沿用旧行为，把 pi 的 system 拼在模板前面。
 *   - `{{tools}}`：替换为动态生成的工具清单。
 *   - `{{examples}}`：替换为根据实际工具名动态生成的正例。
 *   - `{{messages}}`：替换为对话历史（用户 / 助手 / 工具结果消息按顺序拼接）。
 *     模板里出现该占位符时，对话历史不再被自动追加到模板后面 —— 由模板决定
 *     它出现在哪里（你可以在它后面继续写自定义提示词）；缺省时为兼容旧行为
 *     仍会被自动追加到模板末尾。
 */

const TOOL_CALL_FENCE_OPEN = '```tool_call';
const TOOL_CALL_FENCE_CLOSE = '```';
const TOOLS_PLACEHOLDER = '{{tools}}';
const SYSTEM_PLACEHOLDER = '{{system}}';
const MESSAGES_PLACEHOLDER = '{{messages}}';
const EXAMPLES_PLACEHOLDER = '{{examples}}';

// Chinese DSML-style role markers — distinctive enough that the model won't
// accidentally emit them in normal text.  Parameterised to keep them in one
// place for hallucination-stop-sequence alignment in parse-stream.js.
const MARKER_SYSTEM = '<|系统|>';
const MARKER_END_SYSTEM = '<|系统结束|>';
const MARKER_USER   = '<|用户|>';
const MARKER_END_USER = '<|用户结束|>';
const MARKER_ASSISTANT = '<|助手|>';
const MARKER_END_ASSISTANT = '<|助手结束|>';
const MARKER_TOOL   = '<|工具|>';
const MARKER_END_TOOL = '<|工具结果结束|>';
const MARKER_DEVELOPER = '<|开发者|>';
const MARKER_END_DEVELOPER = '<|开发者结束|>';
const MARKER_CONSTRAINT = '<|约束|>';
const MARKER_END_CONSTRAINT = '<|约束结束|>';
const MARKER_TOOL_DEF = '<|工具定义|>';
const MARKER_END_TOOL_DEF = '<|工具定义结束|>';
const MARKER_TOOL_PROTOCOL = '<|工具协议|>';
const MARKER_END_TOOL_PROTOCOL = '<|工具协议结束|>';

// ─── Default injected template ───────────────────────────────────────
// Order intentionally:
//   1. Constraint block — Integrity Guard, Reasoning Effort, Cache Guard
//   2. pi's system prompt (via {{system}})
//   3. Tool list (via {{tools}}) — so the model sees *what* it can call
//   4. Tool protocol rules — so it knows *how* to call
//   5. Parameter type guidance
//   6. Dynamic examples (via {{examples}})
//   7. Error examples
//   8. Dialog history (via {{messages}})

const DEFAULT_TEMPLATE = [
  MARKER_CONSTRAINT,
  '输出完整性守护规则：如果上游上下文、工具输出或被解析文本中包含乱码、损坏、部分解析、重复或其他畸形的片段，禁止模仿或回显它们；只输出面向用户的正确内容。',
  '',
  'Reasoning Effort: Absolute maximum with no shortcuts permitted.',
  'You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.',
  'Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.',
  '',
  '⚠️ 读取工具缓存防护：如果 read / read_file 工具返回空结果（文件不存在、缓存未命中、路径错误等），',
  '不要编造文件内容或假装读到了数据。如实告知用户"文件读取失败/不存在"。',
  '也不要再次重复调用同一个路径的 read 工具 — 结果不会改变。请先确认路径是否正确再决定是否重试。',
  MARKER_END_CONSTRAINT,
  '',
  '{{system}}',
  '',
  MARKER_TOOL_DEF,
  '{{tools}}',
  MARKER_END_TOOL_DEF,
  '',
  MARKER_TOOL_PROTOCOL,
  '# 工具调用协议（必须严格遵守，否则调用作废）',
  '',
  '当你判断需要调用工具时，回答的**最后一部分**必须是一个独立的代码块，格式如下：',
  '',
  TOOL_CALL_FENCE_OPEN,
  '{"name": "工具名", "arguments": {"参数1": "值1", "参数2": "值2"}}',
  TOOL_CALL_FENCE_CLOSE,
  '',
  '## 硬性规则（违反任意一条，调用都会失败）',
  '',
  '1. **JSON 顶层必须正好有两个字段：`name` 和 `arguments`**。',
  '   - `name` 是字符串，等于工具名（见上方"可用工具"清单）。',
  '   - `arguments` 是 JSON 对象，包含该工具的所有参数键值对。',
  '2. **不允许把工具名当作 JSON 顶层键**（如 `{"read": {...}}` 是错误的）。',
  '3. **JSON 必须是合法的、可被 `JSON.parse` 解析的对象**：',
  '   - 无尾随逗号、无未闭合括号、无多余的 `}` 或 `]`。',
  '   - 字符串里的换行用 `\\n`，反斜杠用 `\\\\`，引号用 `\\"`。',
  '4. **代码块的开头必须是单独一行 `' + TOOL_CALL_FENCE_OPEN + '`**，结尾必须是单独一行 ``` （3 个反引号）。',
  '5. **代码块闭合的 ``` 之后绝对不能有任何字符**（包括空格、换行、解释、确认语）。任何"我已经/接下来/好的"等后续文字会被截掉，调用作废。',
  '6. **每次回复最多只能发一个 `tool_call` 代码块**。宿主解析器在第一个 fence 闭合后会立即丢弃之后所有内容。需要多个工具时，分多轮发起，每轮等待真实的工具结果回填后再发下一个。',
  '7. **fence 之前可以写简短解释**，但不要在 fence 之内/之后写任何说明。',
  '8. **禁止凭空叙述工具的执行结果**（这是最严重的错误，会直接损害用户信任）。',
  '   - 真实的工具输出只会以 `' + MARKER_TOOL + '` 开头、`' + MARKER_END_TOOL + '` 结尾的块的形式由宿主回填给你。',
  '   - 如果当前对话历史中还没有 `' + MARKER_TOOL + '` 块，说明工具还未运行过。',
  '   - 你说的"我刚刚读到/看到/检查了 X，内容为 Y"如果缺少对应的 `' + MARKER_TOOL + '` 回填，全部是凭空编造。',
  '   - 需要数据请先调用工具拿到真实结果，等待下一轮宿主回填后再分析和总结。',
  '9. **只能使用工具 schema 中声明的参数名，禁止编造不存在的字段**。严格对照上方"可用工具"的参数列表填写。',
  '10. **如果某个必填参数的值你无法确定，请向用户询问或直接回答**，不要编造参数值、不要填入占位符（如 "..."、"todo"、"unknown"）。',
  '11. **禁止输出空的、仅空格的、或占位符参数值**。每个参数都必须填入有意义的实际值。',
  '12. **代码块不能放在 markdown 代码围栏内**。即不要在 `' + TOOL_CALL_FENCE_OPEN + '` 外面再包一层 ``` 或 ~~~，否则宿主解析器只能看到外层围栏而忽略 tool_call。',
  '13. **禁止在回复中输出系统标记**。`' + MARKER_ASSISTANT + '`、`' + MARKER_TOOL + '`、`' + MARKER_SYSTEM + '`、`' + MARKER_USER + '` 等标记仅由宿主在拼接对话历史时注入，你绝不能在回复中输出它们。',
  '14. **禁止输出代码块形式的假工具结果**。不要在回复中写 `' + TOOL_CALL_FENCE_OPEN + '` 然后放一段 JSON 来冒充工具返回数据。',
  '15. **如果上一轮的工具结果中包含错误信息或空结果**，请如实反映给用户，不要编造正常结果来粉饰。',
  '',
  '## 参数类型指导',
  '',
  '| 参数类型 | JSON 写法 | 正确示例 |',
  '|---------|----------|---------|',
  '| string  | 双引号字符串，需转义特殊字符 | `"hello world"` |',
  '| number  | 纯数字，不带引号 | `42`、`3.14` |',
  '| boolean | `true` 或 `false`，不带引号 | `true` |',
  '| object  | 标准 JSON 对象 | `{"path":"/tmp","mode":"r"}` |',
  '| array   | JSON 数组 | `["error","warn","info"]` |',
  '',
  '## 正确示例 ✅',
  '',
  '{{examples}}',
  '',
  '## 错误示例 ❌（千万不要这样写）',
  '',
  '**错误 1**：把工具名当作顶层键。',
  '',
  TOOL_CALL_FENCE_OPEN,
  '{"read": {"path": "src/index.js"}}        ← 错误：缺少 name / arguments',
  TOOL_CALL_FENCE_CLOSE,
  '',
  '**错误 2**：fence 闭合后还有内容。',
  '',
  TOOL_CALL_FENCE_OPEN,
  '{"name": "read", "arguments": {"path": "src/index.js"}}',
  TOOL_CALL_FENCE_CLOSE,
  '好的，我已经发起调用。  ← 错误：fence 后写了字',
  '',
  '**错误 3**：把工具调用放在 markdown 代码块里（双层围栏）。',
  '',
  '```',
  TOOL_CALL_FENCE_OPEN,
  '{"name": "read", "arguments": {"path": "a.js"}}',
  TOOL_CALL_FENCE_CLOSE,
  '```',
  '← 错误：两层代码块嵌套，宿主解析器只能看到外层 ``` 而忽略 tool_call',
  '',
  '**错误 4**：编造工具结果。',
  '',
  '> 我已经读了 src/index.js，它导出了一个 `start()` 函数，里面调用了 ...',
  '',
  '← 错误：这段描述之前没有任何真实的 `' + MARKER_TOOL + '` 回填块，所以描述的"内容"完全是凭空捏造。正确做法：先发 `tool_call`，等下一轮宿主以 `' + MARKER_TOOL + '...' + MARKER_END_TOOL + '` 回填真实结果后再总结。',
  '',
  '**错误 5**：一次回复发起多个工具调用。',
  '',
  '我同时读两个文件：',
  '',
  TOOL_CALL_FENCE_OPEN,
  '{"name": "read", "arguments": {"path": "a.js"}}',
  TOOL_CALL_FENCE_CLOSE,
  TOOL_CALL_FENCE_OPEN,
  '{"name": "read", "arguments": {"path": "b.js"}}',
  TOOL_CALL_FENCE_CLOSE,
  '',
  '← 错误：第二个 fence 会被解析器静默丢弃，只有第一个真正生效。第二个文件请下一轮再读。',
  '',
  '**错误 6**：用占位符填充参数。',
  '',
  TOOL_CALL_FENCE_OPEN,
  '{"name": "bash", "arguments": {"command": "..."}}',
  TOOL_CALL_FENCE_CLOSE,
  '← 错误：`command` 参数填了 "..." 占位符，不是有效的 shell 命令',
  '',
  MARKER_END_TOOL_PROTOCOL,
  '',
  '{{messages}}',
].join('\n');

// ─── Helpers ─────────────────────────────────────────────────────────

function summarizeParameters(schema) {
  if (!schema || typeof schema !== 'object') return '';
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const keys = Object.keys(props);
  if (keys.length === 0) return '  (无参数)';
  const lines = [];
  for (const key of keys) {
    const p = props[key] || {};
    const req = required.indexOf(key) !== -1 ? '必填' : '可选';
    const type = p.type || 'any';
    const desc = (p.description || '').replace(/\n/g, ' ');
    lines.push('  - ' + key + ' (' + type + ', ' + req + '): ' + desc);
  }
  return lines.join('\n');
}

/**
 * Render the OpenAI tools[] array into a flat "## 可用工具" block
 * that mirrors DS2API's `Tool: name\nDescription: ...\nParameters: ...`
 * style — more readable to the model than nested Markdown headings.
 * Returns empty string when there are no tools.
 */
function buildToolList(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const parts = ['## 可用工具', '', '你有权使用以下工具：'];
  for (const t of tools) {
    const fn = (t && t.function) || t || {};
    const name = fn.name || '(unnamed)';
    parts.push('');
    parts.push('工具: ' + name);
    if (fn.description) parts.push('说明: ' + fn.description);
    parts.push('参数:');
    const paramLines = summarizeParameters(fn.parameters);
    parts.push(paramLines);
  }
  return parts.join('\n');
}

/**
 * Build a set of dynamic correct examples based on the actual tool names
 * available. Match heuristics map known tool-name patterns to realistic
 * usage examples so the model sees concrete patterns it can imitate.
 *
 * When no tools match any known pattern we still output a generic
 * single-tool example so the section is never empty.
 */
function buildDynamicExamples(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';

  const toolNames = [];
  for (const t of tools) {
    const fn = (t && t.function) || t || {};
    if (fn.name) toolNames.push(fn.name);
  }
  if (toolNames.length === 0) return '';

  const lowerNames = toolNames.map(function (n) { return n.toLowerCase(); });
  function hasAny(patterns) {
    for (var pi = 0; pi < patterns.length; pi++) {
      for (var ni = 0; ni < lowerNames.length; ni++) {
        if (lowerNames[ni] === patterns[pi] || lowerNames[ni].indexOf(patterns[pi]) !== -1) return toolNames[ni];
      }
    }
    return null;
  }

  const examples = [];
  var idx = 0;

  // Example A — Single tool (always present)
  const first = toolNames[0];
  examples.push('示例 A — 单工具调用（' + first + '）：');
  examples.push('');
  examples.push('我来调用 ' + first + ' 工具。');
  examples.push('');
  examples.push(TOOL_CALL_FENCE_OPEN);
  examples.push('{"name": "' + first + '", "arguments": {}}');
  examples.push(TOOL_CALL_FENCE_CLOSE);

  // Example B — File read (if Read / read_file present)
  const readName = hasAny(['read', 'read_file']);
  if (readName) {
    idx++;
    const label = String.fromCharCode(65 + idx); // B, C, ...
    examples.push('');
    examples.push('示例 ' + label + ' — 读取文件（' + readName + '）：');
    examples.push('');
    examples.push('我来读一下项目的入口文件。');
    examples.push('');
    examples.push(TOOL_CALL_FENCE_OPEN);
    examples.push('{"name": "' + readName + '", "arguments": {"path": "src/index.js"}}');
    examples.push(TOOL_CALL_FENCE_CLOSE);
  }

  // Example C — Shell command (if Bash / execute_command present)
  const bashName = hasAny(['bash', 'execute_command', 'shell']);
  if (bashName) {
    idx++;
    const label = String.fromCharCode(65 + idx);
    examples.push('');
    examples.push('示例 ' + label + ' — 执行命令（' + bashName + '）：');
    examples.push('');
    examples.push('我来运行单元测试。');
    examples.push('');
    examples.push(TOOL_CALL_FENCE_OPEN);
    examples.push('{"name": "' + bashName + '", "arguments": {"command": "npm run test"}}');
    examples.push(TOOL_CALL_FENCE_CLOSE);
  }

  // Example D — File write (if Write / write_to_file present)
  const writeName = hasAny(['write', 'write_to_file']);
  if (writeName) {
    idx++;
    const label = String.fromCharCode(65 + idx);
    examples.push('');
    examples.push('示例 ' + label + ' — 写入文件（' + writeName + '）：');
    examples.push('');
    examples.push('我来创建一个配置文件。');
    examples.push('');
    examples.push(TOOL_CALL_FENCE_OPEN);
    examples.push('{"name": "' + writeName + '", "arguments": {"path": "config.json", "content": "{\\"port\\": 3000}"}}');
    examples.push(TOOL_CALL_FENCE_CLOSE);
  }

  // Example E — File search (if Glob / search_files / grep present)
  const searchName = hasAny(['glob', 'search_files', 'search_file', 'grep', 'search']);
  if (searchName) {
    idx++;
    const label = String.fromCharCode(65 + idx);
    examples.push('');
    examples.push('示例 ' + label + ' — 搜索文件（' + searchName + '）：');
    examples.push('');
    examples.push('我来搜索所有 JavaScript 文件。');
    examples.push('');
    examples.push(TOOL_CALL_FENCE_OPEN);
    examples.push('{"name": "' + searchName + '", "arguments": {"pattern": "**/*.js"}}');
    examples.push(TOOL_CALL_FENCE_CLOSE);
  }

  return examples.join('\n');
}

/**
 * Substitute `{{system}}` / `{{tools}}` / `{{examples}}` / `{{messages}}`
 * in the user-controlled template. When a placeholder's expansion is
 * empty, the placeholder is dropped cleanly so we don't leave stray
 * blank lines.
 */
function renderTemplate(template, tools, systemBlock, messagesBlock) {
  let out = template;

  const sysText = (typeof systemBlock === 'string' ? systemBlock : '').trim();
  if (sysText) {
    out = out.split(SYSTEM_PLACEHOLDER).join(sysText);
  } else {
    out = out.replace(/\n*\{\{system\}\}\n*/g, '\n\n');
  }

  const toolList = buildToolList(tools);
  if (toolList) {
    out = out.split(TOOLS_PLACEHOLDER).join(toolList);
  } else {
    out = out.replace(/\n*\{\{tools\}\}\n*/g, '\n\n');
  }

  const examples = buildDynamicExamples(tools);
  if (examples) {
    out = out.split(EXAMPLES_PLACEHOLDER).join(examples);
  } else {
    out = out.replace(/\n*\{\{examples\}\}\n*/g, '\n\n');
  }

  const msgText = (typeof messagesBlock === 'string' ? messagesBlock : '').trim();
  if (msgText) {
    out = out.split(MESSAGES_PLACEHOLDER).join(msgText);
  } else {
    out = out.replace(/\n*\{\{messages\}\}\n*/g, '\n\n');
  }

  return out.trim();
}

function stringifyContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const part of content) {
      if (typeof part === 'string') { out.push(part); continue; }
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') { out.push(part.text); continue; }
      if (typeof part.content === 'string') { out.push(part.content); continue; }
      if (part.type === 'image_url' || part.image_url) { out.push('[image]'); continue; }
    }
    return out.join('');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
  }
  return '';
}

function formatToolCallsInAssistant(message) {
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    return null;
  }
  const blocks = [];
  for (const tc of message.tool_calls) {
    const fn = (tc && tc.function) || {};
    let args = fn.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch (_) { /* keep raw */ }
    }
    const payload = { name: fn.name || '', arguments: args == null ? {} : args };
    if (tc.id) payload.id = tc.id;
    blocks.push(
      TOOL_CALL_FENCE_OPEN + '\n' +
      JSON.stringify(payload) + '\n' +
      TOOL_CALL_FENCE_CLOSE
    );
  }
  return blocks.join('\n');
}

function formatMessage(message) {
  if (!message || typeof message !== 'object') return '';
  const role = message.role;
  const content = stringifyContent(message.content);

  switch (role) {
    case 'system':
      return MARKER_SYSTEM + '\n' + content + '\n' + MARKER_END_SYSTEM;
    case 'developer':
      return MARKER_DEVELOPER + '\n' + content + '\n' + MARKER_END_DEVELOPER;
    case 'user':
      return MARKER_USER + '\n' + content + '\n' + MARKER_END_USER;
    case 'assistant': {
      const toolBlock = formatToolCallsInAssistant(message);
      const parts = [MARKER_ASSISTANT];
      if (content) parts.push(content);
      if (toolBlock) parts.push(toolBlock);
      parts.push(MARKER_END_ASSISTANT);
      return parts.join('\n');
    }
    case 'tool': {
      // Empty tool result → fill "(无输出)" so the turn doesn't disappear
      const toolContent = content.trim() === '' ? '(无输出)' : content;
      return MARKER_TOOL + '\n' + toolContent + '\n' + MARKER_END_TOOL;
    }
    default:
      return MARKER_USER + '\n' + content + '\n' + MARKER_END_USER;
  }
}

/**
 * @param {object} body - OpenAI /v1/chat/completions body
 * @param {object} [opts]
 * @param {string} [opts.template] - user-provided override for the injected
 *   block. Defaults to DEFAULT_TEMPLATE. Supports `{{tools}}` placeholder.
 * @returns {string}
 */
function buildPrompt(body, opts) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const tools = Array.isArray(body && body.tools) ? body.tools : [];
  const template = (opts && typeof opts.template === 'string' && opts.template.trim())
    ? opts.template
    : DEFAULT_TEMPLATE;

  const sections = [];

  const systemMsgs = [];
  const dialogMsgs = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') systemMsgs.push(m);
    else dialogMsgs.push(m);
  }

  const systemBlock = systemMsgs.map(formatMessage).filter(Boolean).join('\n\n');
  const messagesBlock = dialogMsgs.map(formatMessage).filter(Boolean).join('\n\n');
  const templateOwnsSystem = template.indexOf(SYSTEM_PLACEHOLDER) !== -1;
  const templateOwnsMessages = template.indexOf(MESSAGES_PLACEHOLDER) !== -1;

  // 1. pi's own system prompt(s) — only auto-prepended when the template
  //    doesn't claim the position via {{system}}.
  if (!templateOwnsSystem && systemBlock) sections.push(systemBlock);

  // 2. Injected template (system / tool list / examples / protocol rules / messages)
  const injected = renderTemplate(template, tools, systemBlock, messagesBlock);
  if (injected) sections.push(injected);

  // 3. Dialog history — only auto-appended when the template doesn't claim
  //    the position via {{messages}}.
  if (!templateOwnsMessages && messagesBlock) sections.push(messagesBlock);

  return sections.filter(Boolean).join('\n\n');
}

module.exports = {
  buildPrompt,
  buildToolList,
  buildDynamicExamples,
  renderTemplate,
  DEFAULT_TEMPLATE,
  TOOL_CALL_FENCE_OPEN,
  TOOL_CALL_FENCE_CLOSE,
  TOOLS_PLACEHOLDER,
  SYSTEM_PLACEHOLDER,
  MESSAGES_PLACEHOLDER,
  EXAMPLES_PLACEHOLDER,
  MARKER_SYSTEM,
  MARKER_END_SYSTEM,
  MARKER_USER,
  MARKER_END_USER,
  MARKER_ASSISTANT,
  MARKER_END_ASSISTANT,
  MARKER_TOOL,
  MARKER_END_TOOL,
  MARKER_DEVELOPER,
  MARKER_END_DEVELOPER,
  MARKER_CONSTRAINT,
  MARKER_END_CONSTRAINT,
  MARKER_TOOL_DEF,
  MARKER_END_TOOL_DEF,
  MARKER_TOOL_PROTOCOL,
  MARKER_END_TOOL_PROTOCOL,
};
