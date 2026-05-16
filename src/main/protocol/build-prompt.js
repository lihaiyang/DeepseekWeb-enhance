'use strict';

/**
 * OpenAI Chat Completions → 单条 DeepSeek prompt
 *
 * DeepSeek 网页只能接收一条 prompt 文本，没有 messages 数组、没有 tool_calls
 * 字段。这里把标准 OpenAI 请求拼成一段自包含文本：系统提示 + 工具列表 +
 * 消息历史，并约定一种工具调用 / 工具结果的纯文本格式让模型遵循。
 *
 * 用户可以覆盖默认的"注入模板"（工具协议规则 + 输出格式硬约束）。模板里用
 * `{{tools}}` 占位符表示"在此处插入动态生成的工具清单"。
 */

const TOOL_CALL_FENCE_OPEN = '```tool_call';
const TOOL_CALL_FENCE_CLOSE = '```';
const TOOLS_PLACEHOLDER = '{{tools}}';

// ─── Default injected template ───────────────────────────────────────
// Order intentionally: tool list first (so the model sees *what* it can
// call), then the call protocol (so it knows *how* to call), then the
// output hard rules (so it knows *what not to write*).

const DEFAULT_TEMPLATE = [
  '{{tools}}',
  '',
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
  '   - `name` 是字符串，等于工具名（见上方"工具清单"）。',
  '   - `arguments` 是 JSON 对象，包含该工具的所有参数键值对。',
  '2. **不允许把工具名当作 JSON 顶层键**。',
  '3. **JSON 必须是合法的、可被 `JSON.parse` 解析的对象**：',
  '   - 无尾随逗号、无未闭合括号、无多余的 `}` 或 `]`。',
  '   - 字符串里的换行用 `\\n`，反斜杠用 `\\\\`，引号用 `\\"`。',
  '4. **代码块的开头必须是单独一行 `' + TOOL_CALL_FENCE_OPEN + '`**，结尾必须是单独一行 ``` （3 个反引号）。',
  '5. **代码块闭合的 ``` 之后绝对不能有任何字符**（包括空格、换行、解释、确认语）。',
  '   任何"我已经/接下来"的话都会被截掉、并让本次调用作废。',
  '6. **一次只发起一个工具调用**。需要多个工具时分多轮进行。',
  '7. **fence 之前可以写一两句解释**，但不要在 fence 之内/之后写任何说明。',
  '',
  '## 正确示例 ✅',
  '',
  '我来读一下文件内容。',
  '',
  TOOL_CALL_FENCE_OPEN,
  '{"name": "read", "arguments": {"path": "src/index.js"}}',
  TOOL_CALL_FENCE_CLOSE,
  '',
  '## 错误示例 ❌（千万不要这样写）',
  '',
  '错误 1：把工具名当作顶层键。',
  '',
  TOOL_CALL_FENCE_OPEN,
  '{"read": {"path": "src/index.js"}}        ← 错误：缺少 name / arguments',
  TOOL_CALL_FENCE_CLOSE,
  '',
  '错误 2：fence 闭合后还有内容。',
  '',
  TOOL_CALL_FENCE_OPEN,
  '{"name": "read", "arguments": {"path": "src/index.js"}}',
  TOOL_CALL_FENCE_CLOSE,
  '好的，我已经发起调用。  ← 错误：fence 后写了字',
  '',
  '错误 3：JSON 多了 `}}` 等多余括号、尾随逗号，导致 `JSON.parse` 失败。',
  '',
  '# 输出格式硬约束（违反会导致输出被截断）',
  '',
  '你的回复只是接在最末尾 `[助手]` 之后的一段助手发言，**绝对不能**输出以下任何分隔符：',
  '',
  '- 行首的 `[用户]`、`[助手]`、`[系统]`、`[开发者]`',
  '- 行首的 `[工具结果` / `[工具结果 id=...]`',
  '',
  '这些标签由宿主系统填充，模型生成它们等于伪造历史。一旦检测到，本次回复会在这些标签处被立即截断，截断点之后的所有内容（包括"已完成 / 已创建"之类的确认）都将丢失。',
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
 * Render the OpenAI tools[] array into a markdown "## 工具清单" block.
 * Returns empty string when there are no tools.
 */
function buildToolList(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const parts = ['## 工具清单'];
  for (const t of tools) {
    const fn = (t && t.function) || t || {};
    parts.push('');
    parts.push('### ' + (fn.name || '(unnamed)'));
    if (fn.description) parts.push(fn.description);
    parts.push('参数：');
    parts.push(summarizeParameters(fn.parameters));
  }
  return parts.join('\n');
}

/**
 * Substitute `{{tools}}` (and any leading/trailing blank lines around it
 * when the list is empty) in the user-controlled template.
 */
function renderTemplate(template, tools) {
  const toolList = buildToolList(tools);
  if (toolList) {
    return template.split(TOOLS_PLACEHOLDER).join(toolList);
  }
  // No tools: drop the placeholder cleanly, collapsing surrounding blank lines.
  return template.replace(/\n*\{\{tools\}\}\n*/g, '\n\n').trim();
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
      return '[系统]\n' + content;
    case 'developer':
      return '[开发者]\n' + content;
    case 'user':
      return '[用户]\n' + content;
    case 'assistant': {
      const toolBlock = formatToolCallsInAssistant(message);
      const parts = ['[助手]'];
      if (content) parts.push(content);
      if (toolBlock) parts.push(toolBlock);
      return parts.join('\n');
    }
    case 'tool': {
      const id = message.tool_call_id || '';
      const head = '[工具结果' + (id ? ' id=' + id : '') + ']';
      return head + '\n' + content;
    }
    default:
      return '[' + (role || 'unknown') + ']\n' + content;
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

  // 1. pi's own system prompt(s)
  for (const m of systemMsgs) sections.push(formatMessage(m));

  // 2. Injected template (tool list + protocol rules + output hard rules)
  const injected = renderTemplate(template, tools);
  if (injected) sections.push(injected);

  // 3. Dialog history
  for (const m of dialogMsgs) sections.push(formatMessage(m));

  // 4. Generation cue
  sections.push('[助手]');

  return sections.filter(Boolean).join('\n\n');
}

module.exports = {
  buildPrompt,
  buildToolList,
  renderTemplate,
  DEFAULT_TEMPLATE,
  TOOL_CALL_FENCE_OPEN,
  TOOL_CALL_FENCE_CLOSE,
  TOOLS_PLACEHOLDER,
};
