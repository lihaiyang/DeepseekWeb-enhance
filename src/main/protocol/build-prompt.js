'use strict';

/**
 * OpenAI Chat Completions → 单条 DeepSeek prompt
 *
 * DeepSeek 网页只能接收一条 prompt 文本，没有 messages 数组、没有 tool_calls
 * 字段。这里把标准 OpenAI 请求拼成一段自包含文本：系统提示 + 工具列表 +
 * 消息历史，并约定一种工具调用 / 工具结果的纯文本格式让模型遵循。
 *
 * 用户可以覆盖默认的"注入模板"（工具协议规则 + 工具清单）。模板里支持三个占位符：
 *   - `{{system}}`：替换为 pi 自带的 system / developer 消息（每条会被格式化
 *     为 `[系统]\n<content>` 块）。模板里出现该占位符时，pi 的 system 不再
 *     被自动前置 —— 由模板决定它出现在哪里；模板里没有该占位符时，沿用旧
 *     行为，把 pi 的 system 拼在模板前面。
 *   - `{{tools}}`：替换为动态生成的工具清单。
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

// ─── Default injected template ───────────────────────────────────────
// Order intentionally: reasoning-effort preamble first (sets the
// "think hard" stance before anything else), then pi's system prompt
// (via {{system}}), then the tool list (so the model sees *what* it
// can call), then the call protocol (so it knows *how* to call), and
// finally the dialog history (via {{messages}}).

const DEFAULT_TEMPLATE = [
  'Reasoning Effort: Absolute maximum with no shortcuts permitted.',
  'You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.',
  'Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.',
  '',
  '{{system}}',
  '',
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
  '6. **每次回复最多只能发一个 `tool_call` fence**。宿主的解析器在第一个 fence 闭合后会立刻进入"丢弃"模式，**之后的所有内容（第二个 fence、叙述、解释、伪造的工具结果）都会被静默吞掉，等于不存在**。需要多个工具时分多轮发起，每轮等待真实的 `[工具结果 id=...]` 回填之后再发下一个。',
  '7. **fence 之前可以写一两句解释**，但不要在 fence 之内/之后写任何说明。',
  '8. **禁止凭空叙述工具的执行结果**。真实的工具输出只会以 `[工具结果 id=...]` 块的形式由宿主回填给你；如果当前对话历史里没有这种块，就意味着工具还没运行过，你说的"我刚刚读到/看到/检查了 X，得到 Y"全是编造，会被用户直接识破。需要数据请先调用工具拿到真实结果。',
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
  '错误 4：编造工具结果。',
  '',
  '> 我已经读了 src/index.js，它导出了一个 `start()` 函数，里面调用了 ...',
  '',
  '← 错误：上面这段话之前没有任何 `tool_call` fence，也没有 `[工具结果 id=...]` 回填，所以这里描述的"内容"完全是凭空捏造。正确做法是先发 `tool_call`，等下一轮宿主回填真实结果后再总结。',
  '',
  '错误 5：一次发起多个工具调用。',
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
 * Substitute `{{system}}` / `{{tools}}` / `{{messages}}` in the
 * user-controlled template. When a placeholder's expansion is empty (no
 * system messages / no tools / no dialog), the placeholder is dropped
 * cleanly so we don't leave stray blank lines.
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

  const systemBlock = systemMsgs.map(formatMessage).filter(Boolean).join('\n\n');
  const messagesBlock = dialogMsgs.map(formatMessage).filter(Boolean).join('\n\n');
  const templateOwnsSystem = template.indexOf(SYSTEM_PLACEHOLDER) !== -1;
  const templateOwnsMessages = template.indexOf(MESSAGES_PLACEHOLDER) !== -1;

  // 1. pi's own system prompt(s) — only auto-prepended when the template
  //    doesn't claim the position via {{system}}.
  if (!templateOwnsSystem && systemBlock) sections.push(systemBlock);

  // 2. Injected template (system / tool list / protocol rules / messages)
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
  renderTemplate,
  DEFAULT_TEMPLATE,
  TOOL_CALL_FENCE_OPEN,
  TOOL_CALL_FENCE_CLOSE,
  TOOLS_PLACEHOLDER,
  SYSTEM_PLACEHOLDER,
  MESSAGES_PLACEHOLDER,
};
