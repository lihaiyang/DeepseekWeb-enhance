'use strict';

/**
 * OpenAI Chat Completions → 单条 DeepSeek prompt
 *
 * DeepSeek 网页只能接收一条 prompt 文本，没有 messages 数组、没有 tool_calls
 * 字段。这里把标准 OpenAI 请求拼成一段自包含文本：系统提示 + 工具列表 +
 * 消息历史，并约定一种工具调用 / 工具结果的纯文本格式让模型遵循。
 */

const TOOL_CALL_FENCE_OPEN = '```tool_call';
const TOOL_CALL_FENCE_CLOSE = '```';

function indent(text, prefix) {
  if (!text) return '';
  return text.split('\n').map(function (l) { return prefix + l; }).join('\n');
}

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

function buildToolSection(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const parts = [];
  parts.push('# 工具调用协议（必须严格遵守，否则调用作废）');
  parts.push('');
  parts.push('当你判断需要调用工具时，回答的**最后一部分**必须是一个独立的代码块，格式如下：');
  parts.push('');
  parts.push(TOOL_CALL_FENCE_OPEN);
  parts.push('{"name": "工具名", "arguments": {"参数1": "值1", "参数2": "值2"}}');
  parts.push(TOOL_CALL_FENCE_CLOSE);
  parts.push('');
  parts.push('## 硬性规则（违反任意一条，调用都会失败）');
  parts.push('');
  parts.push('1. **JSON 顶层必须正好有两个字段：`name` 和 `arguments`**。');
  parts.push('   - `name` 是字符串，等于工具名（见下方"工具清单"）。');
  parts.push('   - `arguments` 是 JSON 对象，包含该工具的所有参数键值对。');
  parts.push('2. **不允许把工具名当作 JSON 顶层键**。');
  parts.push('3. **JSON 必须是合法的、可被 `JSON.parse` 解析的对象**：');
  parts.push('   - 无尾随逗号、无未闭合括号、无多余的 `}` 或 `]`。');
  parts.push('   - 字符串里的换行用 `\\n`，反斜杠用 `\\\\`，引号用 `\\"`。');
  parts.push('4. **代码块的开头必须是单独一行 `' + TOOL_CALL_FENCE_OPEN + '`**，');
  parts.push('   结尾必须是单独一行 ``` （3 个反引号）。');
  parts.push('5. **代码块闭合的 ``` 之后绝对不能有任何字符**（包括空格、换行、解释、确认语）。');
  parts.push('   任何"我已经/接下来"的话都会被截掉、并让本次调用作废。');
  parts.push('6. **一次只发起一个工具调用**。需要多个工具时分多轮进行。');
  parts.push('7. **fence 之前可以写一两句解释**，但不要在 fence 之内/之后写任何说明。');
  parts.push('');
  parts.push('## 正确示例 ✅');
  parts.push('');
  parts.push('我来读一下文件内容。');
  parts.push('');
  parts.push(TOOL_CALL_FENCE_OPEN);
  parts.push('{"name": "read", "arguments": {"path": "src/index.js"}}');
  parts.push(TOOL_CALL_FENCE_CLOSE);
  parts.push('');
  parts.push('## 错误示例 ❌（千万不要这样写）');
  parts.push('');
  parts.push('错误 1：把工具名当作顶层键。');
  parts.push('');
  parts.push(TOOL_CALL_FENCE_OPEN);
  parts.push('{"read": {"path": "src/index.js"}}        ← 错误：缺少 name / arguments');
  parts.push(TOOL_CALL_FENCE_CLOSE);
  parts.push('');
  parts.push('错误 2：fence 闭合后还有内容。');
  parts.push('');
  parts.push(TOOL_CALL_FENCE_OPEN);
  parts.push('{"name": "read", "arguments": {"path": "src/index.js"}}');
  parts.push(TOOL_CALL_FENCE_CLOSE);
  parts.push('好的，我已经发起调用。  ← 错误：fence 后写了字');
  parts.push('');
  parts.push('错误 3：JSON 多了 `}}` 等多余括号、尾随逗号，导致 `JSON.parse` 失败。');
  parts.push('');
  parts.push('## 工具清单');
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
 * Normalise an OpenAI `content` field, which may be:
 *   - a plain string
 *   - an array of parts: { type: "text", text } | { type: "image_url", ... }
 *     | { type: "input_text", text } | { type: "output_text", text }
 *     | plain strings (rare but seen in some clients)
 * Returns a single string.
 */
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
  // OpenAI 协议允许 assistant 同时有 content 和 tool_calls，我们把
  // tool_calls 还原成约定的代码块格式，让模型看到的"历史调用"和它将要
  // 产生的格式一致。
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
 * 把 OpenAI 兼容的请求体翻译成一条 DeepSeek 网页可发送的 prompt。
 *
 * @param {object} body - OpenAI /v1/chat/completions body
 * @returns {string}
 */
function buildPrompt(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const tools = Array.isArray(body && body.tools) ? body.tools : [];

  const sections = [];

  // 先把 system / developer 消息合并到顶部（DeepSeek 没有专门的 system
  // 通道，但保留 role 标签让模型知道这是指令而非用户输入）。
  const systemMsgs = [];
  const dialogMsgs = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') systemMsgs.push(m);
    else dialogMsgs.push(m);
  }

  for (const m of systemMsgs) sections.push(formatMessage(m));

  const toolSection = buildToolSection(tools);
  if (toolSection) sections.push(toolSection);

  // Hard rules about the *format* of the model's reply itself. Without
  // this, DeepSeek will happily extend the visible "dialog script" by
  // hallucinating `[工具结果]` + `[助手]` blocks after its tool call.
  sections.push(
    '# 输出格式硬约束（违反会导致输出被截断）\n' +
    '\n' +
    '你的回复只是接在最末尾 `[助手]` 之后的一段助手发言，**绝对不能**输出以下任何分隔符：\n' +
    '\n' +
    '- 行首的 `[用户]`、`[助手]`、`[系统]`、`[开发者]`\n' +
    '- 行首的 `[工具结果` / `[工具结果 id=...]`\n' +
    '\n' +
    '这些标签由宿主系统填充，模型生成它们等于伪造历史。一旦检测到，本次回复会在这些标签处被立即截断，截断点之后的所有内容（包括"已完成 / 已创建"之类的确认）都将丢失。'
  );

  for (const m of dialogMsgs) sections.push(formatMessage(m));

  // 末尾给模型一个明确的"开始回答"标志，让它接着 [助手] 输出。
  sections.push('[助手]');

  return sections.filter(Boolean).join('\n\n');
}

module.exports = {
  buildPrompt,
  TOOL_CALL_FENCE_OPEN,
  TOOL_CALL_FENCE_CLOSE,
};
