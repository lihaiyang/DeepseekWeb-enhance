// ==UserScript==
// @name         DS Enhance
// @namespace    https://github.com/calendar0917/ds-enhance
// @version      5.0.0
// @description  AI Chat 增强 — 对话管理 + MCP 工具调用 + 多站点适配
// @author       ds-enhance
// @match        https://chat.deepseek.com/*
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_PREFIX = '[DSE]';
  const VERSION = '5.0.0';
  const DEFAULT_MCP_URL = 'http://localhost:8024/mcp';
  const TOOL_CALL_RE = /```mcp:(\w+)\n([\s\S]*?)```/g;

  // ═══════════════════════════════════════════════════════════════════
  //  Constants — DeepSeek API + localStorage keys
  // ═══════════════════════════════════════════════════════════════════
  const DS_API = 'https://chat.deepseek.com/api/v0';
  const LS_CATS = 'dse_categories';
  const LS_PROMPT = 'dse_custom_prompt';
  const CUSTOM_PROMPT_MARKER = '[自定义提示词]';

  // ═══════════════════════════════════════════════════════════════════
  //  Module Toggles (top-level so XHR/fetch hooks can access)
  // ═══════════════════════════════════════════════════════════════════
  const MODULE_DEFAULTS = { mcp: true };
  function getModuleEnabled(mod) { return GM_getValue('mod_' + mod, MODULE_DEFAULTS[mod]); }
  function setModuleEnabled(mod, val) { GM_setValue('mod_' + mod, val); }

  // ═══════════════════════════════════════════════════════════════════
  //  Adapter Registry — Multi-site support
  // ═══════════════════════════════════════════════════════════════════
  const ADAPTERS = {
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek Chat',
      match: (url) => /chat\.deepseek\.com/.test(url),
      selectors: {
        assistantMessages: '.ds-markdown--block, [class*="markdown"]',
        inputBox: 'textarea, [contenteditable="true"][placeholder]',
      },
      getRequestPattern: () => /completion/,
    },
    chatgpt: {
      id: 'chatgpt',
      name: 'ChatGPT',
      match: (url) => /chat\.openai\.com|chatgpt\.com/.test(url),
      selectors: {
        assistantMessages: '[data-message-author-role="assistant"]',
        inputBox: 'textarea[id="prompt-textarea"], #prompt-textarea',
      },
      getRequestPattern: () => /backend-api\/conversation/,
    },
  };

  function detectAdapter() {
    const url = location.href;
    for (const [id, adapter] of Object.entries(ADAPTERS)) {
      if (adapter.match(url)) {
        console.log(`${SCRIPT_PREFIX} Detected adapter: ${adapter.name}`);
        return adapter;
      }
    }
    console.log(`${SCRIPT_PREFIX} No adapter matched for: ${url}`);
    return null;
  }

  const currentAdapter = detectAdapter();

  // ═══════════════════════════════════════════════════════════════════
  //  MCP Client (GM_xmlhttpRequest to bypass CORS)
  // ═══════════════════════════════════════════════════════════════════
  class MCPClient {
    constructor(url) {
      this.url = url;
      this.sessionId = null;
      this._nextId = 1;
      this.connected = false;
    }

    _post(body) {
      return new Promise((resolve, reject) => {
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        GM_xmlhttpRequest({
          method: 'POST', url: this.url, headers,
          data: JSON.stringify(body),
          onload: (resp) => {
            try {
              const text = resp.responseText;
              if (resp.responseHeaders?.includes('text/event-stream')) {
                for (const line of text.split('\n')) {
                  if (line.startsWith('data: ')) { resolve(JSON.parse(line.slice(6))); return; }
                }
                reject(new Error('No data in SSE response'));
              } else {
                resolve(JSON.parse(text));
              }
            } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
          },
          onerror: (e) => reject(new Error(`Network error: ${e.error || 'connection refused'}`)),
          ontimeout: () => reject(new Error('Request timed out')),
          timeout: 30000,
        });
      });
    }

    async _rpc(method, params = {}) {
      const id = this._nextId++;
      const resp = await this._post({ jsonrpc: '2.0', id, method, params });
      if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
      return resp.result;
    }

    async initialize() {
      try {
        const result = await this._rpc('initialize', {
          protocolVersion: '2025-03-26', capabilities: {},
          clientInfo: { name: 'ds-enhance', version: VERSION },
        });
        this.sessionId = result.sessionId;
        this.connected = true;
        await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        console.log(`${SCRIPT_PREFIX} MCP connected: ${this.sessionId}`);
        return true;
      } catch (e) { console.error(`${SCRIPT_PREFIX} Init failed:`, e.message); this.connected = false; return false; }
    }

    async listTools() {
      if (!this.connected) await this.initialize();
      const result = await this._rpc('tools/list');
      return result.tools || [];
    }

    async callTool(name, args = {}) {
      if (!this.connected) await this.initialize();
      return this._rpc('tools/call', { name, arguments: args });
    }

    async checkHealth() {
      try {
        const resp = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET', url: this.url.replace('/mcp', '/health'),
            onload: (r) => resolve(JSON.parse(r.responseText)),
            onerror: (e) => reject(e), timeout: 5000,
          });
        });
        return resp.status === 'ok';
      } catch { return false; }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Tool Registry & Hint Builder
  // ═══════════════════════════════════════════════════════════════════
  let toolRegistry = [];

  function buildToolHint() {
    if (!toolRegistry.length) return '';
    let hint = '[系统指令] 你拥有以下 MCP 工具。当用户的需求可以用工具完成时，你必须在回复中调用工具。';
    hint += ' 调用格式：用代码块写 ```mcp:工具名``` 后紧跟一个 JSON 代码块写参数。\n\n';
    hint += '示例：\n```mcp:execute_command\n{"command": "ls -la"}\n```\n\n';
    hint += '可用工具列表：\n';
    toolRegistry.forEach(t => {
      hint += `- ${t.name}: ${t.description || ''}`;
      const req = t.inputSchema?.required;
      if (req?.length) hint += ` (参数: ${req.join(', ')})`;
      hint += '\n';
    });
    hint += '\n如果不需要工具就正常回答。需要工具时一定要调用。';
    hint += '\n\n当收到用户发送的 <tool_result> 包裹的文本时，这是你之前调用的工具的执行结果。请基于结果继续回答用户的问题。';
    return hint;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  File Context (tool results injection)
  // ═══════════════════════════════════════════════════════════════════
  const _toolFiles = [];

  function addToolFileResult(filename, text, mimeType) {
    _toolFiles.push({ filename, _textContent: text, mime_type: mimeType || 'text/plain' });
  }

  function injectToolFileContext(bodyStr) {
    if (!_toolFiles.length || !bodyStr) return bodyStr;
    try {
      const parsed = JSON.parse(bodyStr);
      let ctx = '\n\n[上传文件内容]\n';
      for (const f of _toolFiles) {
        ctx += `\n--- ${f.filename} ---\n${f._textContent}\n`;
      }
      if (parsed.prompt && typeof parsed.prompt === 'string') {
        parsed.prompt += ctx;
      } else if (parsed.messages?.length) {
        const lastMsg = parsed.messages[parsed.messages.length - 1];
        if (typeof lastMsg.content === 'string') lastMsg.content += ctx;
        else if (Array.isArray(lastMsg.content)) {
          const tp = lastMsg.content.find(p => p.type === 'text');
          if (tp) tp.text += ctx;
        }
      }
      console.log(`${SCRIPT_PREFIX} Injected ${_toolFiles.length} tool file context(s)`);
      _toolFiles.length = 0;
      return JSON.stringify(parsed);
    } catch { return bodyStr; }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Unified modifyRequest — 3 steps: custom prompt → MCP hint → file context
  // ═══════════════════════════════════════════════════════════════════
  function modifyRequest(bodyStr) {
    if (!bodyStr) return bodyStr;

    // Step 1: Inject custom prompt (from enhance)
    const customPrompt = (localStorage.getItem(LS_PROMPT) || '').trim();
    if (customPrompt && !bodyStr.includes(CUSTOM_PROMPT_MARKER)) {
      try {
        const parsed = JSON.parse(bodyStr);
        const tagged = `${CUSTOM_PROMPT_MARKER}\n${customPrompt}`;
        if (parsed.prompt && typeof parsed.prompt === 'string') {
          parsed.prompt = tagged + '\n\n' + parsed.prompt;
          bodyStr = JSON.stringify(parsed);
        } else if (parsed.messages?.length) {
          parsed.messages.unshift({ role: 'system', content: tagged });
          bodyStr = JSON.stringify(parsed);
        }
      } catch { /* not JSON */ }
    }

    // Step 2: Inject MCP tool hint (from bridge)
    if (toolRegistry.length && getModuleEnabled('mcp')) {
      try {
        const parsed = JSON.parse(bodyStr);
        const hint = buildToolHint();
        if (hint && !bodyStr.includes('[系统指令] 你拥有以下 MCP 工具')) {
          if (parsed.prompt && typeof parsed.prompt === 'string') {
            parsed.prompt = hint + '\n\n' + parsed.prompt;
            bodyStr = JSON.stringify(parsed);
          } else if (parsed.messages?.length) {
            const lastMsg = parsed.messages[parsed.messages.length - 1];
            const content = lastMsg?.content;
            if (typeof content === 'string') {
              lastMsg.content = hint + '\n\n' + content;
              bodyStr = JSON.stringify(parsed);
            } else if (Array.isArray(content)) {
              const textPart = content.find(p => p.type === 'text');
              if (textPart && !textPart.text.includes('[系统指令]')) {
                textPart.text = hint + '\n\n' + textPart.text;
                bodyStr = JSON.stringify(parsed);
              }
            }
          }
        }
      } catch { /* not JSON */ }
    }

    // Step 3: Inject tool file context (from bridge)
    bodyStr = injectToolFileContext(bodyStr);

    return bodyStr;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SSE Parsing — DeepSeek native format + OpenAI compatible
  // ═══════════════════════════════════════════════════════════════════
  const executedCalls = new Set();
  let _streamDebounce = null;

  function checkForToolCalls(content) {
    if (!content || !toolRegistry.length) return;

    // Strategy 1: Match ```mcp:tool_name\n{...}\n```
    const re = new RegExp(TOOL_CALL_RE.source, 'g');
    let match;
    while ((match = re.exec(content)) !== null) {
      const toolName = match[1];
      const rawArgs = match[2].trim();
      let args = {};
      try { args = JSON.parse(rawArgs); }
      catch { args = { input: rawArgs }; }

      const key = toolName + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      executedCalls.add(key);

      console.log(`${SCRIPT_PREFIX} Tool call: ${toolName}`, args);
      executeToolCall(toolName, args);
    }

    // Strategy 2: Flex match for SSE token boundary truncation
    for (const tool of toolRegistry) {
      const name = tool.name;
      const idx = content.indexOf(name);
      if (idx === -1) continue;

      const afterName = content.substring(idx + name.length);
      const braceStart = afterName.indexOf('{');
      if (braceStart === -1) continue;

      const braceEnd = afterName.indexOf('}', braceStart);
      if (braceEnd === -1) continue;

      const jsonStr = afterName.substring(braceStart, braceEnd + 1);
      let args = {};
      try { args = JSON.parse(jsonStr); }
      catch { args = { input: jsonStr }; }

      const key = name + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      executedCalls.add(key);

      console.log(`${SCRIPT_PREFIX} Tool call: ${name}`, args);
      executeToolCall(name, args);
    }
  }

  function parseSSEChunk(rawText) {
    let content = '';
    const lines = rawText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const jsonStr = trimmed.slice(6).trim();
      if (jsonStr === '[DONE]') continue;

      try {
        const obj = JSON.parse(jsonStr);

        // DeepSeek native: {"p":"response/content","o":"SET","v":"text"}
        const v = obj.v;
        if (typeof v === 'string' && v.length > 0) {
          const p = obj.p || '';
          if (!p.includes('fragments') && !p.includes('status')) {
            content += v;
          }
          continue;
        }

        // OpenAI streaming: choices[0].delta.content
        const c = obj?.choices?.[0]?.delta?.content;
        if (c) { content += c; continue; }

        // OpenAI non-streaming: choices[0].message.content
        const mc = obj?.choices?.[0]?.message?.content;
        if (mc) { content += mc; continue; }

      } catch { /* not JSON, skip */ }
    }

    return content;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  XHR Hook — unified request modification + SSE stream reading
  // ═══════════════════════════════════════════════════════════════════
  const XHRProto = unsafeWindow.XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;
  const xhrMeta = new WeakMap();

  XHRProto.open = function (method, url, ...rest) {
    xhrMeta.set(this, { url, method });
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XHRProto.send = function (body) {
    const meta = xhrMeta.get(this);
    if (!meta) return origSend.apply(this, [body]);

    const isCompletion = meta.url.includes('completion');

    // Modify request body for all completion requests (custom prompt + MCP hint + file context)
    if (isCompletion && body) {
      body = modifyRequest(body);
    }

    // SSE stream reading for MCP tool call detection
    if (isCompletion && getModuleEnabled('mcp')) {
      let requestContent = '';
      let requestLastLen = 0;

      this.addEventListener('progress', function () {
        try {
          const rt = this.responseText || '';
          if (rt.length <= requestLastLen) return;
          requestLastLen = rt.length;
          requestContent = parseSSEChunk(rt);

          if (_streamDebounce) clearTimeout(_streamDebounce);
          _streamDebounce = setTimeout(() => {
            if (requestContent) checkForToolCalls(requestContent);
          }, 1000);
        } catch { /* ignore */ }
      });

      this.addEventListener('load', function () {
        try {
          const rt = this.responseText || '';
          if (rt) requestContent = parseSSEChunk(rt);
        } catch { /* ignore */ }
        if (_streamDebounce) clearTimeout(_streamDebounce);
        checkForToolCalls(requestContent);
      });
    }

    return origSend.apply(this, [body]);
  };

  // ═══════════════════════════════════════════════════════════════════
  //  fetch Hook — unified request modification + SSE stream reading
  // ═══════════════════════════════════════════════════════════════════
  const origFetch = unsafeWindow.fetch;

  unsafeWindow.fetch = async function (...args) {
    const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;

    if (url && url.includes('completion')) {
      // Modify request body (custom prompt + MCP hint + file context)
      if (args[1]?.body) {
        args[1].body = modifyRequest(args[1].body);
      }

      // SSE stream reading for MCP tool call detection
      if (getModuleEnabled('mcp')) {
        const response = await origFetch.apply(this, args);
        const clone = response.clone();
        clone.text().then(text => {
          const content = parseSSEChunk(text);
          if (content) checkForToolCalls(content);
        }).catch(() => {});
        return response;
      }
    }

    return origFetch.apply(this, args);
  };

  // ═══════════════════════════════════════════════════════════════════
  //  Tool Execution & Result Injection
  // ═══════════════════════════════════════════════════════════════════
  async function executeToolCall(toolName, args) {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    const client = new MCPClient(mcpUrl);

    try {
      toast(`调用工具: ${toolName}...`, 'info');
      const result = await client.callTool(toolName, args);
      const resultText = result?.content?.[0]?.text || '(no result)';
      const isError = result?.isError;

      toast(isError ? `${toolName} 失败` : `${toolName} 完成`, isError ? 'error' : 'success');

      if (!isError && (toolName === 'read_file' || toolName === 'list_directory')) {
        const filename = (args.path || args.filename || 'tool_result.txt').split('/').pop().split('\\').pop();
        addToolFileResult(filename, resultText, 'text/plain');
        toast(`📁 ${filename} 已添加到文件列表`, 'success');
        injectResultToChat(`[工具 ${toolName} 的结果已作为文件添加，共 ${resultText.length} 字符。发送下条消息时会自动附带文件内容。]`);
      } else {
        injectResultToChat(isError ? `Error: ${resultText}` : resultText);
      }
    } catch (e) {
      toast(`工具调用失败: ${e.message}`, 'error');
      console.error(`${SCRIPT_PREFIX} Tool error:`, e);
      injectResultToChat(`Error: ${e.message}`);
    }
  }

  function injectResultToChat(resultText) {
    setTimeout(async () => {
      const wrappedText = `<tool_result>\n${resultText}\n</tool_result>`;
      const input = findInputElement();
      if (!input) { toast('找不到聊天输入框', 'error'); return; }

      input.focus();
      await sleep(200);
      setInputValue(input, wrappedText);
      await sleep(500);
      simulateEnter(input);
      await sleep(300);

      const sendBtn = findSendButton();
      if (sendBtn) sendBtn.click();
      toast('工具结果已发送', 'success');
    }, 1500);
  }

  function findInputElement() {
    for (const ta of document.querySelectorAll('textarea')) {
      if (isVisible(ta)) return ta;
    }
    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const el of editables) {
      if (isVisible(el) && el.getAttribute('placeholder')) return el;
    }
    for (const el of editables) {
      if (isVisible(el)) return el;
    }
    return null;
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label*="send"]', 'button[aria-label*="Send"]',
      'button[aria-label*="发送"]', 'button[aria-label*="Submit"]',
      'button[type="submit"]', 'div[role="button"][aria-label*="send"]',
      'div[role="button"][aria-label*="发送"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn)) return btn;
    }
    return null;
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function setInputValue(element, value) {
    const isCE = element.contentEditable === 'true';

    if (isCE) {
      element.focus();
      const sel = unsafeWindow.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      sel.removeAllRanges();
      sel.addRange(range);

      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: value,
      }));

      try { document.execCommand('insertText', false, value); }
      catch { element.textContent = value; }

      range.selectNodeContents(element);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        unsafeWindow.HTMLInputElement.prototype, 'value'
      )?.set;

      if (setter) setter.call(element, value);
      else element.value = value;
    }

    [
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }),
      new Event('change', { bubbles: true }),
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Unidentified' }),
      new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Unidentified' }),
    ].forEach(e => element.dispatchEvent(e));
  }

  function simulateEnter(element) {
    const init = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    };
    element.dispatchEvent(new KeyboardEvent('keydown', init));
    element.dispatchEvent(new KeyboardEvent('keypress', init));
    element.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ═══════════════════════════════════════════════════════════════════
  //  Toast (used at document-start phase by tool execution)
  // ═══════════════════════════════════════════════════════════════════
  function toast(msg, type = 'info') {
    if (!document.body) return;
    const colors = { info: '#2a2a3e', success: '#0d3320', error: '#3d0f0f' };
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:1000001;background:${colors[type]};color:#eee;padding:12px 22px;border-radius:10px;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:system-ui;transition:opacity .3s;`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Wait for DOM before initializing UI
  // ═══════════════════════════════════════════════════════════════════
  function waitForDOM() {
    return new Promise(resolve => {
      if (document.body) resolve();
      else new MutationObserver(() => { if (document.body) resolve(); })
        .observe(document.documentElement, { childList: true });
    });
  }

  waitForDOM().then(() => {

  // ═══════════════════════════════════════════════════════════════════
  //  Utility functions
  // ═══════════════════════════════════════════════════════════════════
  function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function getSessionId() { const m = location.pathname.match(/\/s\/([a-f0-9-]+)/); return m ? m[1] : null; }

  // ═══════════════════════════════════════════════════════════════════
  //  DeepSeek API layer (only used on deepseek.com)
  // ═══════════════════════════════════════════════════════════════════
  function isDeepSeek() { return currentAdapter?.id === 'deepseek'; }

  function getToken() {
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return null;
      const p = JSON.parse(raw);
      return typeof p === 'object' ? p.value || p.token || p : p;
    } catch {
      return localStorage.getItem('userToken');
    }
  }

  async function api(path, method = 'GET', body) {
    const token = getToken();
    if (!token) throw new Error('未找到 userToken，请先登录 DeepSeek');
    const opts = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-App-Version': '2025.04.25' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${DS_API}${path}`, opts);
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || `API error ${json.code}`);
    return json.data;
  }

  async function fetchSessionsPage(cursor) {
    let url = '/chat_session/fetch_page?count=50';
    if (cursor) url += `&lte_cursor.pinned=${cursor.pinned}&lte_cursor.updated_at=${cursor.updated_at}`;
    return api(url);
  }

  async function fetchAllSessions() {
    const sessions = [];
    let cursor = null;
    for (let i = 0; i < 100; i++) {
      const data = await fetchSessionsPage(cursor);
      const biz = data?.biz_data;
      const list = biz?.chat_sessions || [];
      sessions.push(...list);
      if (!biz?.has_more || !list.length) break;
      const last = list[list.length - 1];
      cursor = { pinned: last.pinned ? 1 : 0, updated_at: last.updated_at };
    }
    return sessions;
  }

  const apiDelete = (id) => api('/chat_session/delete', 'POST', { chat_session_id: id });
  const apiDeleteAll = () => api('/chat_session/delete_all', 'POST');
  const apiRename = (id, title) => api('/chat_session/update_title', 'POST', { chat_session_id: id, title });
  const apiHistory = (id) => api(`/chat/history_messages?chat_session_id=${id}`);
  const apiCreateShare = (sid, mids) => api('/share/create', 'POST', { chat_session_id: sid, message_ids: mids });
  const apiForkShare = (shareId) => api('/share/fork', 'POST', { share_id: shareId });

  // ═══════════════════════════════════════════════════════════════════
  //  Categories (localStorage)
  // ═══════════════════════════════════════════════════════════════════
  function loadCats() {
    try { return JSON.parse(localStorage.getItem(LS_CATS)) || { categories: [], sessionMap: {} }; }
    catch { return { categories: [], sessionMap: {} }; }
  }
  function saveCats(data) { localStorage.setItem(LS_CATS, JSON.stringify(data)); }
  let catData = loadCats();

  function addCategory(name, color) {
    catData.categories.push({ id: 'cat_' + Date.now(), name, color });
    saveCats(catData);
  }
  function removeCategory(catId) {
    catData.categories = catData.categories.filter(c => c.id !== catId);
    for (const sid in catData.sessionMap) {
      catData.sessionMap[sid] = catData.sessionMap[sid].filter(c => c !== catId);
      if (!catData.sessionMap[sid].length) delete catData.sessionMap[sid];
    }
    saveCats(catData);
  }
  function toggleCatSession(sid, catId) {
    if (!catData.sessionMap[sid]) catData.sessionMap[sid] = [];
    const idx = catData.sessionMap[sid].indexOf(catId);
    if (idx >= 0) catData.sessionMap[sid].splice(idx, 1);
    else catData.sessionMap[sid].push(catId);
    if (!catData.sessionMap[sid].length) delete catData.sessionMap[sid];
    saveCats(catData);
  }
  function getSessionCats(sid) { return catData.sessionMap[sid] || []; }
  function filterByCat(sessions, catId) {
    if (!catId) return sessions;
    return sessions.filter(s => (catData.sessionMap[s.id] || []).includes(catId));
  }

  // ═══════════════════════════════════════════════════════════════════
  //  CSS
  // ═══════════════════════════════════════════════════════════════════
  const PANEL_CSS = `
    #dse-fab{position:fixed;z-index:999999;width:48px;height:48px;border-radius:50%;background:#16a34a;color:#fff;border:none;font-size:22px;cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(22,163,74,.4);user-select:none;-webkit-user-select:none;touch-action:none}
    #dse-fab:active{cursor:grabbing}
    #dse-fab:hover{transform:scale(1.1);box-shadow:0 4px 20px rgba(22,163,74,.6)}
    #dse-fab.disconnected{background:#dc2626;box-shadow:0 2px 12px rgba(220,38,38,.4)}
    #dse-fab.disconnected:hover{box-shadow:0 4px 20px rgba(220,38,38,.6)}

    #dse-panel{position:fixed;z-index:999998;width:460px;max-height:min(75vh, calc(100vh - 20px));background:#16161e;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;font-size:14px;display:none;flex-direction:column;overflow:hidden}
    #dse-panel.open{display:flex}
    #dse-panel .hd{padding:14px 18px;border-bottom:1px solid #2a2a3a;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
    #dse-panel .hd h3{margin:0;font-size:15px;font-weight:600}
    #dse-panel .hd .ver{font-size:11px;color:#666;margin-left:8px}
    #dse-panel .hd .cls{background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px}
    #dse-panel .hd .cls:hover{color:#fff}

    #dse-tabs{display:flex;border-bottom:1px solid #2a2a3a;overflow-x:auto;scrollbar-width:none;flex-shrink:0}
    #dse-tabs::-webkit-scrollbar{display:none}
    #dse-tabs button{flex:0 0 auto;padding:9px 14px;background:none;border:none;color:#888;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
    #dse-tabs button.active{color:#7aa2f7;border-bottom-color:#7aa2f7}
    #dse-tabs button:hover{color:#ccc}

    .dse-bd{flex:1;overflow-y:auto;padding:12px 14px}
    .dse-section{display:none}.dse-section.active{display:block}

    .dse-actions{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
    .dse-actions button,.dse-btn{padding:6px 12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;font-size:12px;cursor:pointer;transition:background .15s}
    .dse-actions button:hover,.dse-btn:hover{background:#333}
    .dse-actions button.pri,.dse-btn.pri{background:#16a34a;border-color:#16a34a;color:#fff}
    .dse-actions button.pri:hover,.dse-btn.pri:hover{background:#15803d}
    .dse-actions button.dng{background:#7f1d1d;border-color:#991b1b}
    .dse-actions button.dng:hover{background:#991b1b}

    .dse-input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;box-sizing:border-box;outline:none}
    .dse-input:focus{border-color:#7aa2f7}
    .dse-input::placeholder{color:#555}

    .dse-sel{padding:7px 10px;border:1px solid #444;border-radius:8px;background:#1a1a28;color:#eee;font-size:13px;outline:none}
    .dse-sel option{background:#1a1a28}

    /* session row */
    .dse-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;transition:background .1s}
    .dse-row:hover{background:#1e1e2e}
    .dse-row input[type=checkbox]{width:15px;height:15px;accent-color:#ef4444;cursor:pointer;flex-shrink:0}
    .dse-row .ttl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
    .dse-row .dt{font-size:11px;color:#555;flex-shrink:0}
    .dse-row .btn-sm{background:none;border:none;color:#7aa2f7;cursor:pointer;font-size:11px;flex-shrink:0;padding:2px 6px;border-radius:4px;opacity:0;transition:opacity .15s}
    .dse-row:hover .btn-sm{opacity:1}
    .dse-row .btn-sm:hover{background:#1a2a4a}

    /* category dots */
    .dse-cats{display:flex;gap:3px;flex-shrink:0}
    .dse-catdot{width:10px;height:10px;border-radius:50%;cursor:pointer;transition:transform .1s}
    .dse-catdot:hover{transform:scale(1.3)}

    /* cat filter bar */
    .dse-catfilter{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
    .dse-catfilter button{padding:4px 10px;border-radius:12px;border:1px solid #444;background:#222;color:#aaa;font-size:11px;cursor:pointer}
    .dse-catfilter button.active{border-color:#7aa2f7;color:#7aa2f7;background:#1a2a4a}

    /* category management */
    .dse-catmgmt{margin-bottom:12px;padding:10px;background:#1a1a28;border-radius:10px}
    .dse-catmgmt .row{display:flex;gap:6px;margin-bottom:6px;align-items:center}
    .dse-catmgmt .row input[type=color]{width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;background:none}
    .dse-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:11px;cursor:pointer;margin:2px}
    .dse-chip:hover{filter:brightness(1.2)}
    .dse-chip .x{font-size:13px;opacity:.6}.dse-chip .x:hover{opacity:1}

    /* progress */
    .dse-prog{font-size:13px;color:#aaa;padding:8px 0}
    .dse-prog .bar{height:4px;background:#333;border-radius:2px;margin-top:6px;overflow:hidden}
    .dse-prog .bar-i{height:100%;background:#16a34a;border-radius:2px;transition:width .2s}

    /* modal */
    .dse-modal-bg{position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center}
    .dse-modal-box{background:#1a1a28;color:#eee;border-radius:14px;padding:0;min-width:380px;max-width:520px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;overflow:hidden}
    .dse-modal-box .mhd{padding:16px 20px;border-bottom:1px solid #2a2a3a;font-size:15px;font-weight:600}
    .dse-modal-box .mbd{padding:14px 20px;max-height:360px;overflow-y:auto}
    .dse-modal-box .mft{padding:12px 20px;border-top:1px solid #2a2a3a;display:flex;justify-content:flex-end;gap:8px}
    .dse-modal-box .mft button{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px}
    .dse-modal-box .mft .cancel{background:#333;color:#eee}.dse-modal-box .mft .cancel:hover{background:#444}
    .dse-modal-box .mft .confirm{background:#16a34a;color:#fff;font-weight:600}.dse-modal-box .mft .confirm:hover{background:#15803d}
    .dse-msg-row{padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:flex-start;gap:8px;font-size:13px}
    .dse-msg-row:hover{background:#222238}.dse-msg-row.sel{background:#1a2e50}
    .dse-msg-row .num{color:#7aa2f7;font-weight:600;min-width:30px;font-size:12px}
    .dse-msg-row .preview{color:#aaa;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    /* rename preview */
    .dse-rename-preview{margin:10px 0;font-size:12px}
    .dse-rename-preview .old{color:#888;text-decoration:line-through}
    .dse-rename-preview .arrow{color:#555;margin:0 6px}
    .dse-rename-preview .new{color:#7aa2f7}

    /* MCP tool list */
    .dse-tool{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;transition:background .1s;font-size:13px}
    .dse-tool:hover{background:#1e1e2e}
    .dse-tool .name{color:#7aa2f7;font-weight:500}
    .dse-tool .desc{color:#888;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    .dse-result{margin-top:10px;padding:10px;background:#1a1a28;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow-y:auto;color:#aaa;font-family:monospace}
    .dse-result.error{color:#f87171}
    .dse-label{font-size:12px;color:#888;margin-bottom:4px;display:block}
    .dse-label-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .dse-status{font-size:13px;padding:8px 0}
    .dse-status .ok{color:#4ade80}
    .dse-status .err{color:#f87171}

    /* ext card */
    .ext-card{padding:10px 12px;border:1px solid #333;border-radius:10px;margin-bottom:8px;background:#1a1a28}
    .ext-card-hd{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .ext-card-name{font-weight:600;color:#7aa2f7;font-size:14px}
    .ext-card-transport{font-size:11px;color:#666;background:#222;padding:2px 6px;border-radius:4px}
    .ext-card-status{font-size:12px;display:flex;align-items:center;gap:4px}
    .ext-card-status .dot{width:7px;height:7px;border-radius:50%;display:inline-block}
    .ext-card-status .dot-green{background:#4ade80}.ext-card-status .dot-red{background:#f87171}.ext-card-status .dot-gray{background:#666}
    .ext-card-tools{font-size:11px;color:#888;margin-top:6px}
    .ext-card-actions{display:flex;gap:6px;margin-top:8px}
    .ext-card-actions .dse-btn{font-size:11px;padding:4px 10px}
    .ext-form-row{margin-bottom:8px}
    .ext-form-row label{font-size:11px;color:#888;display:block;margin-bottom:3px}
    .ext-form-row input{font-size:12px}
    .ext-add-toggle{font-size:12px;color:#7aa2f7;cursor:pointer;border:none;background:none;padding:0;margin-top:6px}
    .ext-add-toggle:hover{text-decoration:underline}
    .ext-section{margin-top:10px;padding-top:10px;border-top:1px solid #2a2a3a}

    /* Module toggles */
    .dse-toggle-row { display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #2a2a3a; }
    .dse-toggle-label { font-size:13px;color:#ccc; }
    .dse-toggle-desc { font-size:11px;color:#666;margin-top:2px; }
    .dse-switch { position:relative;width:36px;height:20px;flex-shrink:0; }
    .dse-switch input { opacity:0;width:0;height:0; }
    .dse-switch .slider { position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#333;border-radius:10px;transition:.2s; }
    .dse-switch .slider:before { position:absolute;content:"";height:16px;width:16px;left:2px;bottom:2px;background:#888;border-radius:50%;transition:.2s; }
    .dse-switch input:checked + .slider { background:#16a34a; }
    .dse-switch input:checked + .slider:before { transform:translateX(16px);background:#fff; }

    /* disabled notice for non-DeepSeek sites */
    .dse-disabled-notice { color:#888; font-size:12px; padding:8px 0; font-style:italic; }
  `;

  // ═══════════════════════════════════════════════════════════════════
  //  FAB + Panel
  // ═══════════════════════════════════════════════════════════════════
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.id = 'dse-fab';
  fab.innerHTML = '&#9881;';
  fab.title = 'DS Enhance (可拖动)';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'dse-panel';

  // Build tab buttons — DeepSeek-only tabs are conditionally shown
  const dsOnly = !isDeepSeek();
  panel.innerHTML = `
    <div class="hd">
      <h3>DS Enhance <span class="ver">v${VERSION}</span></h3>
      <button class="cls">&times;</button>
    </div>
    <div id="dse-tabs">
      <button class="active" data-tab="chat">对话</button>
      <button data-tab="fork">Fork</button>
      <button data-tab="cats">分类</button>
      <button data-tab="rename">重命名</button>
      <button data-tab="mcp">MCP</button>
      <button data-tab="ext">服务器</button>
      <button data-tab="prompt">提示词</button>
      <button data-tab="settings">设置</button>
    </div>
    <div class="dse-bd">

      <!-- Chat management (delete + search + export combined) -->
      <div id="sec-chat" class="dse-section active">
        ${dsOnly ? '<div class="dse-disabled-notice">对话管理功能仅支持 DeepSeek Chat</div>' : `
        <div class="dse-actions">
          <button id="chat-load">加载对话列表</button>
          <button id="chat-sel-all">全选</button>
          <button id="chat-desel">取消全选</button>
        </div>
        <div class="dse-actions">
          <button id="chat-del" class="dng">删除选中</button>
          <button id="chat-del-all" class="dng">清空全部</button>
        </div>
        <input type="text" id="chat-search" class="dse-input" placeholder="搜索对话标题..." style="margin-bottom:6px">
        <div id="chat-search-count" style="font-size:12px;color:#666;margin-bottom:6px"></div>
        <div class="dse-actions">
          <select id="chat-exp-format" class="dse-sel">
            <option value="json">导出 JSON</option>
            <option value="md">导出 Markdown</option>
          </select>
          <button id="chat-exp-go" class="dse-btn pri" style="font-size:12px">导出选中</button>
        </div>
        <div id="chat-status" class="dse-prog" style="display:none"></div>
        <div id="chat-list"></div>
        `}
      </div>

      <!-- Fork -->
      <div id="sec-fork" class="dse-section">
        ${dsOnly ? '<div class="dse-disabled-notice">Fork 功能仅支持 DeepSeek Chat</div>' : `
        <div style="margin-bottom:12px">
          <div style="color:#aaa;font-size:13px;margin-bottom:6px">当前对话</div>
          <div id="fork-info" style="font-size:13px;color:#888"></div>
          <div class="dse-actions" style="margin-top:8px">
            <button id="fork-entire">Fork 整个对话</button>
            <button id="fork-pick" class="pri">Fork (选择起点)</button>
          </div>
        </div>
        <hr style="border:none;border-top:1px solid #2a2a3a;margin:12px 0">
        <div style="color:#aaa;font-size:13px;margin-bottom:6px">从历史列表 Fork</div>
        <div class="dse-actions"><button id="fork-load">加载对话列表</button></div>
        <div id="fork-list"></div>
        `}
      </div>

      <!-- Categories -->
      <div id="sec-cats" class="dse-section">
        ${dsOnly ? '<div class="dse-disabled-notice">分类功能仅支持 DeepSeek Chat</div>' : `
        <div class="dse-catmgmt">
          <div style="color:#aaa;font-size:12px;margin-bottom:8px">管理分类</div>
          <div class="row">
            <input type="text" id="cat-name" class="dse-input" placeholder="分类名称" style="flex:1">
            <input type="color" id="cat-color" value="#3b82f6" style="width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;background:none">
            <button id="cat-add" class="dse-btn pri" style="padding:6px 14px">添加</button>
          </div>
          <div id="cat-chips"></div>
          <div class="dse-actions" style="margin-top:8px">
            <button id="cat-export-data">导出分类数据</button>
            <button id="cat-import-data">导入分类数据</button>
          </div>
        </div>
        <div class="dse-actions">
          <button id="cat-load">加载对话列表</button>
        </div>
        <div class="dse-catfilter" id="cat-filter-bar"></div>
        <div id="cat-list"></div>
        `}
      </div>

      <!-- Rename -->
      <div id="sec-rename" class="dse-section">
        ${dsOnly ? '<div class="dse-disabled-notice">重命名功能仅支持 DeepSeek Chat</div>' : `
        <div class="dse-actions">
          <button id="rnm-load">加载对话列表</button>
          <button id="rnm-sel-all">全选</button>
          <button id="rnm-desel">取消全选</button>
        </div>
        <div style="margin-bottom:10px">
          <select id="rnm-mode" class="dse-sel" style="margin-bottom:6px">
            <option value="direct">直接重命名</option>
            <option value="prefix">添加前缀</option>
            <option value="suffix">添加后缀</option>
            <option value="replace">查找替换</option>
            <option value="serial">序号命名</option>
          </select>
          <div id="rnm-params"></div>
        </div>
        <div class="dse-actions">
          <button id="rnm-preview">预览</button>
          <button id="rnm-go" class="dse-btn pri">执行重命名</button>
        </div>
        <div id="rnm-status" class="dse-prog" style="display:none"></div>
        <div id="rnm-preview-area"></div>
        <div id="rnm-list"></div>
        `}
      </div>

      <!-- MCP status + test (combined) -->
      <div id="sec-mcp" class="dse-section">
        <div id="mcp-status-area"></div>
        <hr style="border:none;border-top:1px solid #2a2a3a;margin:12px 0">
        <div style="font-size:12px;font-weight:600;color:#ccc;margin-bottom:8px">工具测试</div>
        <div id="mcp-test-area"></div>
      </div>

      <!-- External MCP servers -->
      <div id="sec-ext" class="dse-section">
        <div id="ext-area"></div>
      </div>

      <!-- Prompt injection -->
      <div id="sec-prompt" class="dse-section">
        <div style="color:#aaa;font-size:13px;margin-bottom:8px">自定义系统提示词（每次对话自动注入，仅 DeepSeek）</div>
        <textarea id="prompt-text" class="dse-input" rows="6" placeholder="例如：你是一个严谨的技术助手，回答请用中文，输出格式用 Markdown。" style="resize:vertical;min-height:100px"></textarea>
        <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
          <button id="prompt-save" class="dse-btn pri">保存</button>
          <button id="prompt-clear" class="dse-btn">清除</button>
          <span id="prompt-status" style="font-size:12px;color:#666"></span>
        </div>
      </div>

      <!-- Settings -->
      <div id="sec-settings" class="dse-section">
        <div>
          <label class="dse-label">MCP 服务器地址</label>
          <input class="dse-input" id="cfg-url" value="${GM_getValue('mcp_url', DEFAULT_MCP_URL)}" />
        </div>
        <div style="margin-top:16px">
          <label class="dse-label">模块开关</label>
          <div class="dse-toggle-row">
            <div><div class="dse-toggle-label">🔧 MCP 工具调用</div><div class="dse-toggle-desc">拦截 AI 回复并执行本地工具</div></div>
            <label class="dse-switch"><input type="checkbox" id="mod-toggle-mcp" ${getModuleEnabled('mcp') ? 'checked' : ''} /><span class="slider"></span></label>
          </div>
        </div>
        <div style="margin-top:8px;font-size:11px;color:#555">适配器: ${currentAdapter ? currentAdapter.name : '无'}</div>
        <div style="margin-top:12px"><button class="dse-btn pri" id="cfg-save">保存</button></div>
      </div>

    </div>
  `;
  document.body.appendChild(panel);
  panel.querySelector('.cls').onclick = () => panel.classList.remove('open');

  // ── Drag ──
  let fabDragged = false, fabSX, fabSY, fabOX, fabOY;
  const DRAG_TH = 5;

  function posPanel() {
    const r = fab.getBoundingClientRect();
    const TOP_MARGIN = 50;
    let l = r.right - 460;
    if (l + 460 > window.innerWidth - 10) l = window.innerWidth - 470;
    if (l < 10) l = 10;
    panel.style.left = l + 'px';

    const gap = 10;
    const spaceAbove = r.top - gap - TOP_MARGIN;
    const maxH = Math.min(window.innerHeight * 0.75, window.innerHeight - 2 * TOP_MARGIN);

    if (spaceAbove >= 200) {
      panel.style.bottom = (window.innerHeight - r.top + gap) + 'px';
      panel.style.top = 'auto';
    } else {
      panel.style.top = TOP_MARGIN + 'px';
      panel.style.bottom = 'auto';
    }
    panel.style.maxHeight = maxH + 'px';
  }

  fab.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    fabDragged = false; fabSX = e.clientX; fabSY = e.clientY;
    const r = fab.getBoundingClientRect();
    fabOX = e.clientX - r.left; fabOY = e.clientY - r.top;
    const mv = (e) => {
      if (!fabDragged && Math.abs(e.clientX - fabSX) + Math.abs(e.clientY - fabSY) < DRAG_TH) return;
      fabDragged = true;
      fab.style.left = Math.max(0, Math.min(innerWidth - 48, e.clientX - fabOX)) + 'px';
      fab.style.top = Math.max(0, Math.min(innerHeight - 48, e.clientY - fabOY)) + 'px';
      fab.style.bottom = 'auto';
    };
    const up = () => {
      document.removeEventListener('pointermove', mv);
      document.removeEventListener('pointerup', up);
      if (!fabDragged) { panel.classList.toggle('open'); if (panel.classList.contains('open')) { posPanel(); refreshMCPStatus(); } }
      else if (panel.classList.contains('open')) posPanel();
    };
    document.addEventListener('pointermove', mv);
    document.addEventListener('pointerup', up);
    e.preventDefault();
  });

  fab.style.right = '20px';
  fab.style.left = 'auto';
  fab.style.top = (innerHeight - 68) + 'px';

  // ── Tab switching ──
  panel.querySelectorAll('#dse-tabs button').forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll('#dse-tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      panel.querySelectorAll('.dse-section').forEach(s => s.classList.remove('active'));
      panel.querySelector(`#sec-${tab}`).classList.add('active');
      if (tab === 'fork') updateForkInfo();
      if (tab === 'cats') renderCatChips();
      if (tab === 'mcp') { refreshMCPStatus(); renderTestTab(); }
      if (tab === 'ext') renderExtTab();
    };
  });

  // ── Shortcut ──
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) { posPanel(); refreshMCPStatus(); }
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Shared state for chat management
  // ═══════════════════════════════════════════════════════════════════
  let allSessions = [];
  const selIds = new Set();
  let activeCatFilter = null;

  async function ensureSessions() {
    if (!allSessions.length) {
      allSessions = await fetchAllSessions();
    }
    return allSessions;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Session list renderer (shared)
  // ═══════════════════════════════════════════════════════════════════
  function renderList(container, sessions, opts = {}) {
    const { showFork, showCats, onCheck, highlight } = opts;
    container.innerHTML = '';
    if (!sessions.length) { container.innerHTML = '<div style="color:#555;font-size:13px;padding:12px 0">暂无对话</div>'; return; }
    sessions.forEach(s => {
      const row = document.createElement('div');
      row.className = 'dse-row';

      if (onCheck) {
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = selIds.has(s.id);
        cb.onchange = () => { if (cb.checked) selIds.add(s.id); else selIds.delete(s.id); };
        row.appendChild(cb);
      }

      if (showCats) {
        const catsDiv = document.createElement('span');
        catsDiv.className = 'dse-cats';
        const sc = getSessionCats(s.id);
        sc.forEach(cid => {
          const cat = catData.categories.find(c => c.id === cid);
          if (!cat) return;
          const dot = document.createElement('span');
          dot.className = 'dse-catdot';
          dot.style.background = cat.color;
          dot.title = cat.name;
          catsDiv.appendChild(dot);
        });
        row.appendChild(catsDiv);
      }

      const ttl = document.createElement('span');
      ttl.className = 'ttl';
      if (highlight) {
        const re = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        ttl.innerHTML = esc(s.title || '(无标题)').replace(re, '<mark style="background:#2a3a1a;color:#a0ffa0;border-radius:2px;padding:0 2px">$1</mark>');
      } else {
        ttl.textContent = s.title || '(无标题)';
      }

      const dt = document.createElement('span');
      dt.className = 'dt';
      dt.textContent = fmtDate(s.updated_at);

      row.appendChild(ttl);
      row.appendChild(dt);

      if (showFork) {
        const fb = document.createElement('button');
        fb.className = 'btn-sm'; fb.textContent = 'Fork';
        fb.onclick = (e) => { e.stopPropagation(); forkEntire(s.id); };
        row.appendChild(fb);
      }

      if (showCats) {
        const tb = document.createElement('button');
        tb.className = 'btn-sm'; tb.textContent = '标签';
        tb.style.color = '#aaa';
        tb.onclick = (e) => { e.stopPropagation(); showCatPicker(s.id); };
        row.appendChild(tb);
      }

      container.appendChild(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Chat Tab — batch delete + search + export (combined)
  // ═══════════════════════════════════════════════════════════════════
  if (isDeepSeek()) {
    const chatListEl = panel.querySelector('#chat-list');
    const chatStatusEl = panel.querySelector('#chat-status');
    const chatSearchEl = panel.querySelector('#chat-search');
    const chatCountEl = panel.querySelector('#chat-search-count');

    function showChatProg(t, p) { chatStatusEl.style.display = 'block'; chatStatusEl.innerHTML = `<div>${esc(t)}</div><div class="bar"><div class="bar-i" style="width:${p}%"></div></div>`; }
    function hideChatProg() { chatStatusEl.style.display = 'none'; }

    function doChatSearch() {
      const q = chatSearchEl.value.trim().toLowerCase();
      if (!q) { chatCountEl.textContent = `共 ${allSessions.length} 条`; renderList(chatListEl, allSessions, { onCheck: true, showCats: true }); return; }
      const matched = allSessions.filter(s => (s.title || '').toLowerCase().includes(q));
      chatCountEl.textContent = `找到 ${matched.length} 条`;
      renderList(chatListEl, matched, { onCheck: true, showCats: true, highlight: chatSearchEl.value.trim() });
    }

    panel.querySelector('#chat-load').onclick = async () => {
      try { chatListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>'; allSessions = await fetchAllSessions(); selIds.clear(); renderList(chatListEl, allSessions, { onCheck: true, showCats: true }); chatCountEl.textContent = `共 ${allSessions.length} 条`; toast(`已加载 ${allSessions.length} 条对话`, 'success'); }
      catch (e) { toast(`加载失败: ${e.message}`, 'error'); chatListEl.innerHTML = ''; }
    };
    panel.querySelector('#chat-sel-all').onclick = () => { allSessions.forEach(s => selIds.add(s.id)); doChatSearch(); };
    panel.querySelector('#chat-desel').onclick = () => { selIds.clear(); doChatSearch(); };
    chatSearchEl.addEventListener('input', doChatSearch);

    panel.querySelector('#chat-del').onclick = async () => {
      if (!selIds.size) { toast('请先选择', 'error'); return; }
      if (!confirm(`确定删除 ${selIds.size} 条对话？不可撤销。`)) return;
      const ids = [...selIds]; let ok = 0, fail = 0;
      for (let i = 0; i < ids.length; i++) {
        showChatProg(`删除中 ${i + 1}/${ids.length}`, ((i + 1) / ids.length) * 100);
        try { await apiDelete(ids[i]); ok++; } catch { fail++; }
      }
      hideChatProg(); toast(`完成: 成功 ${ok}, 失败 ${fail}`, ok ? 'success' : 'error');
      allSessions = await fetchAllSessions(); selIds.clear();
      renderList(chatListEl, allSessions, { onCheck: true, showCats: true });
    };

    panel.querySelector('#chat-del-all').onclick = async () => {
      if (!confirm('⚠️ 删除【所有】对话？不可撤销！')) return;
      if (!confirm('再次确认！')) return;
      try { showChatProg('清空中...', 50); await apiDeleteAll(); hideChatProg(); toast('已清空', 'success'); allSessions = []; selIds.clear(); renderList(chatListEl, [], {}); }
      catch (e) { hideChatProg(); toast(`失败: ${e.message}`, 'error'); }
    };

    panel.querySelector('#chat-exp-go').onclick = async () => {
      if (!selIds.size) { toast('请先选择要导出的对话', 'error'); return; }
      const fmt = panel.querySelector('#chat-exp-format').value;
      const ids = [...selIds];
      const results = [];

      for (let i = 0; i < ids.length; i++) {
        showChatProg(`导出中 ${i + 1}/${ids.length}`, ((i + 1) / ids.length) * 100);
        const s = allSessions.find(x => x.id === ids[i]);
        try {
          const h = await apiHistory(ids[i]);
          const msgs = h?.biz_data?.chat_messages || [];
          results.push({ session: s, messages: msgs });
        } catch (e) {
          results.push({ session: s, messages: [], error: e.message });
        }
      }
      hideChatProg();

      const date = new Date().toISOString().slice(0, 10);
      if (fmt === 'json') {
        const json = JSON.stringify(results, null, 2);
        download(`dse-export-${date}.json`, json, 'application/json');
      } else {
        let md = '';
        results.forEach(r => {
          md += `# ${r.session?.title || '(无标题)'}\n\n`;
          md += `- 日期: ${fmtDate(r.session?.updated_at)}\n`;
          md += `- ID: ${r.session?.id}\n\n`;
          if (r.error) { md += `> 导出失败: ${r.error}\n\n`; return; }
          r.messages.forEach(m => {
            const role = m.role === 'USER' ? '**用户**' : '**助手**';
            md += `### ${role}\n\n${m.content || ''}\n\n---\n\n`;
          });
          md += '\n';
        });
        download(`dse-export-${date}.md`, md, 'text/markdown');
      }
      toast(`已导出 ${results.length} 个对话`, 'success');
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Fork Tab
  // ═══════════════════════════════════════════════════════════════════
  if (isDeepSeek()) {
    const forkListEl = panel.querySelector('#fork-list');

    function updateForkInfo() {
      const sid = getSessionId();
      panel.querySelector('#fork-info').innerHTML = sid
        ? `<code style="color:#7aa2f7;font-size:12px">${sid}</code>`
        : '<span style="color:#888">未打开对话，请先打开一个对话</span>';
    }

    async function forkEntire(sessionId) {
      if (!confirm('Fork 此对话？将创建一份完整副本。')) return;
      try {
        toast('获取消息中...', 'info');
        const hist = await apiHistory(sessionId);
        const msgs = hist?.biz_data?.chat_messages || [];
        if (!msgs.length) { toast('对话为空', 'error'); return; }
        const mids = msgs.map(m => m.message_id);
        toast('创建分享...', 'info');
        const sd = await apiCreateShare(sessionId, mids);
        const shareId = sd?.biz_data?.share_id;
        if (!shareId) throw new Error('创建分享失败');
        toast('Fork 中...', 'info');
        const fd = await apiForkShare(shareId);
        const newId = fd?.biz_data?.chat_session_id;
        if (!newId) throw new Error('Fork 失败');
        toast('Fork 成功！', 'success');
        setTimeout(() => { location.href = `/a/chat/s/${newId}`; }, 800);
      } catch (e) { toast(`Fork 失败: ${e.message}`, 'error'); }
    }

    function showForkPicker(sessionId, messages) {
      const userMsgs = messages.filter(m => m.role === 'USER' && m.status !== 'in_progress');
      if (!userMsgs.length) { toast('没有用户消息', 'error'); return; }
      let sel = userMsgs.length - 1;
      const bg = document.createElement('div'); bg.className = 'dse-modal-bg';
      bg.innerHTML = `<div class="dse-modal-box"><div class="mhd">选择 Fork 起点</div><div class="mbd" id="fp-list"></div><div class="mft"><button class="cancel">取消</button><button class="confirm">确认 Fork</button></div></div>`;
      const listEl = bg.querySelector('#fp-list');
      userMsgs.forEach((m, i) => {
        const r = document.createElement('div'); r.className = `dse-msg-row ${i === sel ? 'sel' : ''}`;
        r.innerHTML = `<span class="num">#${i + 1}</span><span class="preview">${esc((m.content || '').substring(0, 120))}</span>`;
        r.onclick = () => { listEl.querySelectorAll('.dse-msg-row').forEach(e => e.classList.remove('sel')); r.classList.add('sel'); sel = i; };
        listEl.appendChild(r);
      });
      bg.querySelector('.cancel').onclick = () => bg.remove();
      bg.onclick = e => { if (e.target === bg) bg.remove(); };
      bg.querySelector('.confirm').onclick = async () => {
        bg.remove();
        const sm = userMsgs[sel];
        const mm = new Map(messages.map(m => [m.message_id, m]));
        const ids = []; let cur = sm;
        while (cur) { ids.unshift(cur.message_id); cur = cur.parent_id ? mm.get(cur.parent_id) : null; }
        const idx = messages.findIndex(m => m.message_id === sm.message_id);
        if (idx >= 0 && idx + 1 < messages.length) { const n = messages[idx + 1]; if (n.role === 'ASSISTANT' && n.parent_id === sm.message_id) ids.push(n.message_id); }
        try {
          toast('Fork 中...', 'info');
          const sd = await apiCreateShare(sessionId, ids);
          const shareId = sd?.biz_data?.share_id; if (!shareId) throw new Error('创建分享失败');
          const fd = await apiForkShare(shareId);
          const newId = fd?.biz_data?.chat_session_id; if (!newId) throw new Error('Fork 失败');
          toast('Fork 成功！', 'success'); setTimeout(() => { location.href = `/a/chat/s/${newId}`; }, 800);
        } catch (e) { toast(`失败: ${e.message}`, 'error'); }
      };
      document.body.appendChild(bg);
    }

    panel.querySelector('#fork-entire').onclick = () => { const s = getSessionId(); s ? forkEntire(s) : toast('请先打开一个对话', 'error'); };
    panel.querySelector('#fork-pick').onclick = async () => {
      const s = getSessionId();
      if (!s) { toast('请先打开一个对话', 'error'); return; }
      try { toast('加载消息...', 'info'); const h = await apiHistory(s); const m = h?.biz_data?.chat_messages || []; if (!m.length) { toast('对话为空', 'error'); return; } showForkPicker(s, m); }
      catch (e) { toast(`失败: ${e.message}`, 'error'); }
    };
    panel.querySelector('#fork-load').onclick = async () => {
      try { forkListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>'; allSessions = await fetchAllSessions(); renderList(forkListEl, allSessions, { showFork: true, showCats: true }); toast(`已加载 ${allSessions.length} 条`, 'success'); }
      catch (e) { toast(`失败: ${e.message}`, 'error'); forkListEl.innerHTML = ''; }
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Categories Tab
  // ═══════════════════════════════════════════════════════════════════
  if (isDeepSeek()) {
    const catListEl = panel.querySelector('#cat-list');
    const catChipsEl = panel.querySelector('#cat-chips');
    const catFilterBar = panel.querySelector('#cat-filter-bar');

    function renderCatChips() {
      catChipsEl.innerHTML = '';
      catData.categories.forEach(c => {
        const chip = document.createElement('span');
        chip.className = 'dse-chip';
        chip.style.background = c.color + '22';
        chip.style.color = c.color;
        chip.style.border = `1px solid ${c.color}44`;
        chip.innerHTML = `${esc(c.name)} <span class="x">&times;</span>`;
        chip.querySelector('.x').onclick = (e) => { e.stopPropagation(); if (confirm(`删除分类「${c.name}」？`)) { removeCategory(c.id); renderCatChips(); renderCatFilterBar(); } };
        catChipsEl.appendChild(chip);
      });
    }

    function renderCatFilterBar() {
      catFilterBar.innerHTML = '';
      const allBtn = document.createElement('button');
      allBtn.textContent = '全部';
      if (!activeCatFilter) allBtn.classList.add('active');
      allBtn.onclick = () => { activeCatFilter = null; renderCatFilterBar(); renderCatListFiltered(); };
      catFilterBar.appendChild(allBtn);
      catData.categories.forEach(c => {
        const btn = document.createElement('button');
        btn.textContent = c.name;
        btn.style.borderColor = c.color;
        if (activeCatFilter === c.id) { btn.classList.add('active'); btn.style.background = c.color + '33'; }
        btn.onclick = () => { activeCatFilter = activeCatFilter === c.id ? null : c.id; renderCatFilterBar(); renderCatListFiltered(); };
        catFilterBar.appendChild(btn);
      });
    }

    function renderCatListFiltered() {
      const filtered = filterByCat(allSessions, activeCatFilter);
      renderList(catListEl, filtered, { showCats: true });
    }

    function showCatPicker(sid) {
      const bg = document.createElement('div'); bg.className = 'dse-modal-bg';
      const box = document.createElement('div'); box.className = 'dse-modal-box';
      box.innerHTML = `<div class="mhd">为对话分配标签</div><div class="mbd" id="cp-list"></div><div class="mft"><button class="cancel">完成</button></div>`;
      bg.appendChild(box); document.body.appendChild(bg);

      const cpList = box.querySelector('#cp-list');
      const sc = getSessionCats(sid);
      catData.categories.forEach(c => {
        const r = document.createElement('div'); r.className = 'dse-msg-row';
        const has = sc.includes(c.id);
        r.innerHTML = `<span style="width:14px;height:14px;border-radius:50%;background:${c.color};flex-shrink:0"></span><span style="flex:1">${esc(c.name)}</span><span style="color:${has ? '#7aa2f7' : '#555'}">${has ? '已选' : ''}</span>`;
        r.onclick = () => { toggleCatSession(sid, c.id); showCatPicker(sid); bg.remove(); };
        cpList.appendChild(r);
      });

      box.querySelector('.cancel').onclick = () => bg.remove();
      bg.onclick = e => { if (e.target === bg) bg.remove(); };
    }

    panel.querySelector('#cat-add').onclick = () => {
      const name = panel.querySelector('#cat-name').value.trim();
      const color = panel.querySelector('#cat-color').value;
      if (!name) { toast('请输入分类名称', 'error'); return; }
      addCategory(name, color);
      panel.querySelector('#cat-name').value = '';
      renderCatChips(); renderCatFilterBar();
      toast(`已添加「${name}」`, 'success');
    };

    panel.querySelector('#cat-load').onclick = async () => {
      try { catListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>'; allSessions = await fetchAllSessions(); renderCatFilterBar(); renderCatListFiltered(); toast(`已加载 ${allSessions.length} 条`, 'success'); }
      catch (e) { toast(`失败: ${e.message}`, 'error'); }
    };

    panel.querySelector('#cat-export-data').onclick = () => {
      const json = JSON.stringify(catData, null, 2);
      download('dse-categories.json', json, 'application/json');
      toast('分类数据已导出', 'success');
    };
    panel.querySelector('#cat-import-data').onclick = () => {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
      inp.onchange = async () => {
        const file = inp.files[0]; if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data.categories || !data.sessionMap) throw new Error('格式错误');
          catData = data; saveCats(catData);
          renderCatChips(); renderCatFilterBar();
          toast('分类数据已导入', 'success');
        } catch (e) { toast(`导入失败: ${e.message}`, 'error'); }
      };
      inp.click();
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Rename Tab
  // ═══════════════════════════════════════════════════════════════════
  if (isDeepSeek()) {
    const rnmListEl = panel.querySelector('#rnm-list');
    const rnmStatusEl = panel.querySelector('#rnm-status');
    const rnmPreviewEl = panel.querySelector('#rnm-preview-area');
    const rnmMode = panel.querySelector('#rnm-mode');
    const rnmParams = panel.querySelector('#rnm-params');
    function showRnmProg(t, p) { rnmStatusEl.style.display = 'block'; rnmStatusEl.innerHTML = `<div>${esc(t)}</div><div class="bar"><div class="bar-i" style="width:${p}%"></div></div>`; }
    function hideRnmProg() { rnmStatusEl.style.display = 'none'; }

    function renderRenameParams() {
      const mode = rnmMode.value;
      if (mode === 'direct') rnmParams.innerHTML = '<div style="margin-top:4px;font-size:12px;color:#888">选中对话后点击下方「加载选中」，每条会显示一个输入框可直接编辑标题</div>';
      else if (mode === 'prefix') rnmParams.innerHTML = '<input type="text" id="rnm-prefix" class="dse-input" placeholder="输入前缀..." style="margin-top:4px">';
      else if (mode === 'suffix') rnmParams.innerHTML = '<input type="text" id="rnm-suffix" class="dse-input" placeholder="输入后缀..." style="margin-top:4px">';
      else if (mode === 'replace') rnmParams.innerHTML = '<div style="display:flex;gap:6px;margin-top:4px"><input type="text" id="rnm-find" class="dse-input" placeholder="查找"><input type="text" id="rnm-repl" class="dse-input" placeholder="替换为"></div>';
      else if (mode === 'serial') rnmParams.innerHTML = '<div style="display:flex;gap:6px;margin-top:4px;align-items:center"><input type="text" id="rnm-fmt" class="dse-input" placeholder="格式: {n} {title}" value="{n}. {title}" style="flex:1"><span style="font-size:11px;color:#666">可用: {n} {name}</span></div>';
    }
    rnmMode.onchange = () => { renderRenameParams(); rnmPreviewEl.innerHTML = ''; };
    renderRenameParams();

    function getNewTitle(s, idx, mode) {
      const t = s.title || '(无标题)';
      if (mode === 'prefix') { const p = rnmParams.querySelector('#rnm-prefix')?.value || ''; return p + t; }
      if (mode === 'suffix') { const p = rnmParams.querySelector('#rnm-suffix')?.value || ''; return t + p; }
      if (mode === 'replace') {
        const find = rnmParams.querySelector('#rnm-find')?.value || '';
        const repl = rnmParams.querySelector('#rnm-repl')?.value || '';
        if (!find) return t;
        return t.split(find).join(repl);
      }
      if (mode === 'serial') {
        const fmt = rnmParams.querySelector('#rnm-fmt')?.value || '{n}. {title}';
        const n = String(idx + 1).padStart(3, '0');
        return fmt.replace(/\{n\}/g, n).replace(/\{title\}/g, t).replace(/\{name\}/g, t);
      }
      return t;
    }

    function renderDirectRenameList(sessions) {
      rnmListEl.innerHTML = '';
      if (!sessions.length) { rnmListEl.innerHTML = '<div style="color:#555;font-size:13px;padding:12px 0">暂无对话</div>'; return; }
      sessions.forEach(s => {
        const row = document.createElement('div');
        row.className = 'dse-row';
        row.style.cursor = 'default';
        const dt = document.createElement('span');
        dt.className = 'dt';
        dt.textContent = fmtDate(s.updated_at);
        dt.style.marginRight = '6px';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'dse-input';
        inp.value = s.title || '';
        inp.style.flex = '1';
        inp.dataset.sid = s.id;
        row.appendChild(dt);
        row.appendChild(inp);
        rnmListEl.appendChild(row);
      });
    }

    panel.querySelector('#rnm-load').onclick = async () => {
      try {
        rnmListEl.innerHTML = '<div style="color:#888;padding:8px 0">加载中...</div>';
        allSessions = await fetchAllSessions();
        selIds.clear();
        if (rnmMode.value === 'direct') {
          renderDirectRenameList(allSessions);
        } else {
          renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
        }
        rnmPreviewEl.innerHTML = '';
        toast(`已加载 ${allSessions.length} 条`, 'success');
      }
      catch (e) { toast(`失败: ${e.message}`, 'error'); }
    };
    panel.querySelector('#rnm-sel-all').onclick = () => {
      if (rnmMode.value === 'direct') return;
      allSessions.forEach(s => selIds.add(s.id)); renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
    };
    panel.querySelector('#rnm-desel').onclick = () => {
      if (rnmMode.value === 'direct') return;
      selIds.clear(); renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
    };

    panel.querySelector('#rnm-preview').onclick = () => {
      if (rnmMode.value === 'direct') { toast('直接重命名模式无需预览，直接编辑输入框即可', 'info'); return; }
      if (!selIds.size) { toast('请先选择', 'error'); return; }
      const mode = rnmMode.value;
      const selected = allSessions.filter(s => selIds.has(s.id));
      let html = '';
      selected.forEach((s, i) => {
        const oldT = s.title || '(无标题)';
        const newT = getNewTitle(s, i, mode);
        html += `<div class="dse-rename-preview"><span class="old">${esc(oldT)}</span><span class="arrow">→</span><span class="new">${esc(newT)}</span></div>`;
      });
      rnmPreviewEl.innerHTML = html;
    };

    panel.querySelector('#rnm-go').onclick = async () => {
      const mode = rnmMode.value;

      if (mode === 'direct') {
        const inputs = rnmListEl.querySelectorAll('input[data-sid]');
        if (!inputs.length) { toast('请先点击「加载对话列表」', 'error'); return; }
        const renames = [];
        inputs.forEach(inp => {
          const sid = inp.dataset.sid;
          const newTitle = inp.value.trim();
          const old = allSessions.find(s => s.id === sid);
          if (old && newTitle && newTitle !== (old.title || '')) {
            renames.push({ id: sid, title: newTitle });
          }
        });
        if (!renames.length) { toast('没有需要修改的标题', 'info'); return; }
        if (!confirm(`确定重命名 ${renames.length} 条对话？`)) return;
        let ok = 0, fail = 0;
        for (let i = 0; i < renames.length; i++) {
          showRnmProg(`重命名中 ${i + 1}/${renames.length}`, ((i + 1) / renames.length) * 100);
          try { await apiRename(renames[i].id, renames[i].title); ok++; } catch { fail++; }
        }
        hideRnmProg();
        toast(`完成: 成功 ${ok}, 失败 ${fail}`, ok ? 'success' : 'error');
        allSessions = await fetchAllSessions();
        renderDirectRenameList(allSessions);
        return;
      }

      if (!selIds.size) { toast('请先选择', 'error'); return; }
      const selected = allSessions.filter(s => selIds.has(s.id));
      if (!confirm(`确定重命名 ${selected.length} 条对话？`)) return;

      let ok = 0, fail = 0;
      for (let i = 0; i < selected.length; i++) {
        showRnmProg(`重命名中 ${i + 1}/${selected.length}`, ((i + 1) / selected.length) * 100);
        const newT = getNewTitle(selected[i], i, mode);
        try { await apiRename(selected[i].id, newT); ok++; } catch { fail++; }
      }
      hideRnmProg();
      toast(`完成: 成功 ${ok}, 失败 ${fail}`, ok ? 'success' : 'error');
      allSessions = await fetchAllSessions(); selIds.clear();
      renderList(rnmListEl, allSessions, { onCheck: true, showCats: true });
      rnmPreviewEl.innerHTML = '';
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  MCP Tab — status + test (combined)
  // ═══════════════════════════════════════════════════════════════════
  const mcpStatusArea = panel.querySelector('#mcp-status-area');
  const mcpTestArea = panel.querySelector('#mcp-test-area');

  async function refreshMCPStatus() {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    mcpStatusArea.innerHTML = '<div class="dse-status">连接中...</div>';
    const client = new MCPClient(mcpUrl);
    const healthy = await client.checkHealth();

    if (!healthy) {
      fab.classList.add('disconnected');
      toolRegistry = [];
      mcpStatusArea.innerHTML = `
        <div class="dse-status"><span class="err">未连接</span> — 服务器未运行</div>
        <div style="font-size:12px;color:#666;margin-top:8px">
          请先启动 MCP 服务器：<br>
          <code style="color:#7aa2f7">cd server && python server.py</code>
        </div>
        <div style="margin-top:12px">
          <button class="dse-btn pri" id="mcp-retry">重试连接</button>
        </div>
      `;
      mcpStatusArea.querySelector('#mcp-retry').onclick = refreshMCPStatus;
      mcpTestArea.innerHTML = '<div style="color:#665;font-size:13px">请先连接服务器</div>';
      return;
    }

    // Fetch health info for external server status
    let healthInfo = null;
    try {
      const resp = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url: mcpUrl.replace('/mcp', '/health'),
          onload: (r) => resolve(JSON.parse(r.responseText)),
          onerror: (e) => reject(e), timeout: 5000,
        });
      });
      healthInfo = resp;
    } catch {}

    const tools = await client.listTools();
    toolRegistry = tools;
    fab.classList.remove('disconnected');

    const extServers = healthInfo?.external_servers || [];
    const extToolNames = new Set();
    extServers.forEach(s => s.tools?.forEach(t => extToolNames.add(t)));

    let toolList = '';
    tools.forEach(t => {
      const desc = t.description || '';
      const req = t.inputSchema?.required;
      const params = req?.length ? ` (${req.join(', ')})` : '';
      const badge = extToolNames.has(t.name)
        ? '<span style="font-size:10px;color:#f0ad4e;margin-left:4px">ext</span>' : '';
      toolList += `<div class="dse-tool"><span class="name">${esc(t.name)}${esc(params)}${badge}</span><span class="desc">${esc(desc)}</span></div>`;
    });

    let extInfo = '';
    if (extServers.length > 0) {
      extInfo = '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #2a2a3a">';
      extInfo += '<div style="font-size:12px;color:#888;margin-bottom:6px">外部 MCP 服务器</div>';
      extServers.forEach(s => {
        const icon = s.connected ? '&#10003;' : '&#10007;';
        const color = s.connected ? '#4ade80' : '#f87171';
        extInfo += `<div style="font-size:12px;color:#aaa;margin-bottom:4px"><span style="color:${color}">${icon}</span> <strong>${esc(s.name)}</strong> (${s.transport}) — ${s.tools?.length || 0} tools</div>`;
      });
      extInfo += '</div>';
    }

    const builtinCount = tools.length - extToolNames.size;
    const summary = extServers.length > 0
      ? `${tools.length} 个工具 (${builtinCount} 内置 + ${extToolNames.size} 外部)`
      : `${tools.length} 个工具`;

    mcpStatusArea.innerHTML = `
      <div class="dse-status"><span class="ok">已连接</span> — ${summary}</div>
      ${extInfo}
      <div style="margin-top:8px">${toolList || '<div style="color:#665">无可用工具</div>'}</div>
      <div style="margin-top:12px">
        <button class="dse-btn pri" id="mcp-refresh">刷新</button>
      </div>
    `;
    mcpStatusArea.querySelector('#mcp-refresh').onclick = refreshMCPStatus;
    console.log(`${SCRIPT_PREFIX} ready — ${tools.length} tools (${extToolNames.size} external)`);
  }

  function renderTestTab() {
    if (!toolRegistry.length) {
      mcpTestArea.innerHTML = '<div style="color:#665;font-size:13px">请先连接服务器</div>';
      return;
    }

    let opts = '<option value="">选择工具...</option>';
    toolRegistry.forEach(t => { opts += `<option value="${t.name}">${t.name}</option>`; });

    mcpTestArea.innerHTML = `
      <div class="dse-label-row">
        <label class="dse-label" style="margin:0">工具</label>
      </div>
      <select class="dse-sel" id="test-sel">${opts}</select>
      <div id="test-info" style="margin-top:8px;font-size:12px;color:#666"></div>
      <div id="test-args" style="margin-top:10px"></div>
      <div style="margin-top:10px">
        <button class="dse-btn pri" id="test-run">执行</button>
      </div>
      <div id="test-result"></div>
    `;

    const sel = mcpTestArea.querySelector('#test-sel');
    const info = mcpTestArea.querySelector('#test-info');
    const argsDiv = mcpTestArea.querySelector('#test-args');
    const resultDiv = mcpTestArea.querySelector('#test-result');

    sel.onchange = () => {
      const tool = toolRegistry.find(t => t.name === sel.value);
      if (!tool) { info.textContent = ''; argsDiv.innerHTML = ''; return; }
      info.textContent = tool.description || '';
      const schema = tool.inputSchema || {};
      const props = schema.properties || {};
      const required = schema.required || [];
      let fields = '';
      for (const [key, prop] of Object.entries(props)) {
        const req = required.includes(key) ? ' *' : '';
        const ph = prop.description || prop.type || '';
        fields += `<div style="margin-bottom:6px">
          <label class="dse-label">${key}${req}</label>
          <input class="dse-input" data-arg="${key}" placeholder="${ph}" />
        </div>`;
      }
      if (!fields) fields = '<div style="color:#666;font-size:12px">此工具无需参数</div>';
      argsDiv.innerHTML = fields;
    };

    mcpTestArea.querySelector('#test-run').onclick = async () => {
      const toolName = sel.value;
      if (!toolName) { toast('请选择工具', 'error'); return; }
      const args = {};
      argsDiv.querySelectorAll('.dse-input').forEach(inp => {
        const key = inp.dataset.arg;
        const val = inp.value.trim();
        if (val) {
          try { args[key] = JSON.parse(val); }
          catch { args[key] = val; }
        }
      });

      resultDiv.innerHTML = '<div class="dse-result">执行中...</div>';
      const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
      const client = new MCPClient(mcpUrl);
      try {
        const result = await client.callTool(toolName, args);
        const text = result?.content?.[0]?.text || '(no result)';
        const isErr = result?.isError;
        resultDiv.innerHTML = `<div class="dse-result${isErr ? ' error' : ''}">${esc(text)}</div>`;
      } catch (e) {
        resultDiv.innerHTML = `<div class="dse-result error">Error: ${esc(e.message)}</div>`;
      }
    };
  }

  // ── Health check polling ──
  let _healthConnected = null;

  async function checkConnection() {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    try {
      const resp = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: mcpUrl.replace('/mcp', '/health'),
          onload: (r) => {
            try { resolve(JSON.parse(r.responseText)); }
            catch { reject(new Error('invalid response')); }
          },
          onerror: () => reject(new Error('network error')),
          timeout: 5000,
        });
      });

      const nowOk = resp.status === 'ok';
      if (_healthConnected === false && nowOk) {
        toast('服务器已恢复连接，正在重新加载...', 'success');
        refreshMCPStatus();
      }
      _healthConnected = nowOk;
      fab.classList.toggle('disconnected', !nowOk);
    } catch {
      if (_healthConnected !== false) {
        _healthConnected = false;
        fab.classList.add('disconnected');
        toolRegistry = [];
        toast('服务器连接断开', 'error');
      }
    }
  }

  checkConnection();
  setInterval(checkConnection, 30000);

  // ═══════════════════════════════════════════════════════════════════
  //  External MCP Servers Tab
  // ═══════════════════════════════════════════════════════════════════
  const extArea = panel.querySelector('#ext-area');

  function getExtBaseUrl() {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    try { return new URL(mcpUrl).origin; }
    catch { return mcpUrl.replace(/\/[^/]*$/, ''); }
  }

  function extApiUrl(path) { return getExtBaseUrl() + path; }

  async function extApiCall(path, method = 'GET', body) {
    const url = extApiUrl(path);
    return new Promise((resolve, reject) => {
      const opts = {
        method, url, timeout: 15000,
        headers: { 'Content-Type': 'application/json' },
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText)); }
          catch { reject(new Error('Invalid JSON')); }
        },
        onerror: (e) => reject(new Error(e.error || 'Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      };
      if (body) opts.data = JSON.stringify(body);
      GM_xmlhttpRequest(opts);
    });
  }

  let extFormOpen = false;
  let presetParamForm = null;

  async function renderExtTab() {
    extArea.innerHTML = '<div style="color:#888;font-size:13px">加载中...</div>';

    let presets = [], servers = [];
    try {
      const [presetData, serverData] = await Promise.all([
        extApiCall('/api/presets'),
        extApiCall('/api/external-servers'),
      ]);
      presets = presetData.presets || [];
      servers = serverData.servers || [];
    } catch (e) {
      extArea.innerHTML = `<div style="color:#f87171;font-size:13px">连接失败: ${esc(e.message)}</div>`;
      return;
    }

    const installedIds = new Set(servers.map(s => s.name));
    let html = '';

    // Preset Marketplace
    html += '<div style="font-size:12px;font-weight:600;color:#ccc;margin-bottom:8px">工具预设</div>';

    const categories = {};
    presets.forEach(p => {
      const cat = p.category || '其他';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(p);
    });

    for (const [cat, items] of Object.entries(categories)) {
      html += `<div style="font-size:10px;color:#666;margin:6px 0 3px">${esc(cat)}</div>`;
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:6px">';
      items.forEach(p => {
        const installed = installedIds.has(p.id);
        const hasParams = p.params?.length > 0;
        const btnText = installed ? (hasParams ? '重新配置' : '已启用') : (hasParams ? '配置' : '启用');
        const btnStyle = installed
          ? (hasParams
              ? 'background:#222;color:#7aa2f7;border-color:#7aa2f7'
              : 'background:#1a3a2a;color:#4ade80;border-color:#4ade80;pointer-events:none')
          : 'background:#222;color:#7aa2f7;border-color:#7aa2f7';
        html += `
          <div class="ext-preset-install" data-preset-id="${esc(p.id)}" style="padding:6px 8px;border:1px solid ${installed ? '#2a4a3a' : '#333'};border-radius:6px;background:${installed ? '#1a2a22' : '#1a1a28'}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:12px;font-weight:500;color:#ccc">${esc(p.name)}</span>
              <button class="dse-btn ext-preset-install" data-preset-id="${esc(p.id)}" style="${btnStyle};font-size:10px;padding:1px 7px">${btnText}</button>
            </div>
            <div style="font-size:10px;color:#888;margin-top:2px">${esc(p.description)}</div>
          </div>
        `;
      });
      html += '</div>';
    }

    // Param form
    if (presetParamForm) {
      const p = presetParamForm;
      html += `
        <div class="ext-section" id="ext-param-form">
          <div style="font-size:13px;font-weight:600;color:#ccc;margin-bottom:8px">配置: ${esc(p.name)}</div>
      `;
      p.params.forEach(param => {
        const req = param.required ? ' *' : '';
        const inputType = param.secret ? 'password' : 'text';
        html += `
          <div style="margin-bottom:6px">
            <label style="font-size:11px;color:#888;display:block;margin-bottom:2px">${esc(param.label)}${req}</label>
            <input class="dse-input ext-param-input" data-key="${esc(param.key)}" type="${inputType}"
                   placeholder="${esc(param.placeholder || '')}" style="font-size:12px" />
          </div>
        `;
      });
      html += `
          <div style="margin-top:8px;display:flex;gap:6px">
            <button class="dse-btn pri" id="ext-param-submit">安装</button>
            <button class="dse-btn" id="ext-param-cancel">取消</button>
          </div>
        </div>
      `;
    }

    // Installed Servers
    if (servers.length > 0) {
      html += '<div class="ext-section">';
      html += '<div style="font-size:12px;font-weight:600;color:#ccc;margin-bottom:6px">已安装</div>';
      servers.forEach(s => {
        const dotClass = s.status === 'running' ? 'dot-green' : s.status === 'stopped' ? 'dot-gray' : 'dot-red';
        const statusText = s.status === 'running' ? '运行中' : s.status === 'stopped' ? '已停止' : '异常';
        const statusColor = s.status === 'running' ? '#4ade80' : s.status === 'stopped' ? '#888' : '#f87171';
        const toolsStr = s.tools?.length ? s.tools.join(', ') : '—';

        let actions = '';
        if (s.status === 'running') {
          actions = `<button class="dse-btn ext-stop" data-name="${esc(s.name)}" style="font-size:11px;padding:3px 8px">停止</button>`;
        } else {
          actions = `<button class="dse-btn pri ext-start" data-name="${esc(s.name)}" style="font-size:11px;padding:3px 8px">启动</button>`;
        }
        actions += `<button class="dse-btn ext-remove" data-name="${esc(s.name)}" style="color:#f87171;border-color:#f87171;font-size:11px;padding:3px 8px">删除</button>`;

        html += `
          <div class="ext-card" style="padding:8px 10px;margin-bottom:6px">
            <div class="ext-card-hd">
              <div style="display:flex;align-items:center;gap:8px">
                <span class="ext-card-name" style="font-size:13px">${esc(s.name)}</span>
                <span class="ext-card-transport">${s.transport}</span>
              </div>
              <span class="ext-card-status"><span class="dot ${dotClass}"></span><span style="color:${statusColor}">${statusText}</span></span>
            </div>
            <div class="ext-card-tools" style="font-size:10px">工具: ${esc(toolsStr)}</div>
            <div class="ext-card-actions" style="margin-top:6px">${actions}</div>
          </div>
        `;
      });
      html += '</div>';
    }

    // Add form — JSON import
    const defaultJson = JSON.stringify({
      "mcpServers": {
        "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
        "fetch": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-fetch"] }
      }
    }, null, 2);

    html += `<div style="margin-top:10px"><button class="ext-add-toggle" id="ext-add-btn">+ 导入 JSON 配置</button></div>`;
    html += `<div id="ext-add-form" style="display:${extFormOpen ? 'block' : 'none'};margin-top:6px">`;
    html += `
      <div style="font-size:10px;color:#888;margin-bottom:4px">
        支持粘贴任意格式的 MCP 配置 JSON，可同时导入多个
      </div>
      <textarea id="ext-f-json" style="width:100%;height:120px;padding:6px;border-radius:6px;border:1px solid #444;background:#0d0d18;color:#a0a0c0;font-size:10px;font-family:monospace;resize:vertical;box-sizing:border-box;outline:none;line-height:1.4" spellcheck="false">${esc(defaultJson)}</textarea>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button class="dse-btn pri" id="ext-add-submit" style="font-size:11px;padding:4px 10px">导入并启动</button>
        <button class="dse-btn" id="ext-add-cancel" style="font-size:11px;padding:4px 10px">取消</button>
      </div>
    </div>`;
    html += `<div style="margin-top:8px"><button class="dse-btn" id="ext-refresh" style="font-size:11px">刷新</button></div>`;

    extArea.innerHTML = html;

    // Preset install/configure buttons
    extArea.querySelectorAll('.ext-preset-install').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const presetId = btn.dataset.presetId;
        const preset = presets.find(p => p.id === presetId);
        if (!preset) return;

        if (preset.params?.length > 0) {
          presetParamForm = preset;
          renderExtTab();
        } else if (!installedIds.has(presetId)) {
          try {
            const result = await extApiCall(`/api/presets/${presetId}/install`, 'POST', {});
            if (result.ok) {
              toast(`${preset.name} 已安装，${result.tools?.length || 0} 个工具`, 'success');
              renderExtTab();
              refreshMCPStatus();
            } else {
              toast(result.error || '安装失败', 'error');
            }
          } catch (e) { toast(e.message, 'error'); }
        }
      };
    });

    // Param form submit
    const paramSubmit = extArea.querySelector('#ext-param-submit');
    if (paramSubmit) {
      paramSubmit.onclick = async () => {
        const params = {};
        extArea.querySelectorAll('.ext-param-input').forEach(inp => {
          params[inp.dataset.key] = inp.value.trim();
        });
        try {
          const result = await extApiCall(`/api/presets/${presetParamForm.id}/install`, 'POST', { params });
          if (result.ok) {
            toast(`${presetParamForm.name} 已安装，${result.tools?.length || 0} 个工具`, 'success');
            presetParamForm = null;
            renderExtTab();
            refreshMCPStatus();
          } else {
            toast(result.error || '安装失败', 'error');
          }
        } catch (e) { toast(e.message, 'error'); }
      };
    }

    const paramCancel = extArea.querySelector('#ext-param-cancel');
    if (paramCancel) {
      paramCancel.onclick = () => { presetParamForm = null; renderExtTab(); };
    }

    // Add form toggle
    const addBtn = extArea.querySelector('#ext-add-btn');
    if (addBtn) {
      addBtn.onclick = () => { extFormOpen = !extFormOpen; renderExtTab(); };
    }

    const addCancel = extArea.querySelector('#ext-add-cancel');
    if (addCancel) {
      addCancel.onclick = () => { extFormOpen = false; renderExtTab(); };
    }

    // Add form submit — JSON import
    const addSubmit = extArea.querySelector('#ext-add-submit');
    if (addSubmit) {
      addSubmit.onclick = async () => {
        const jsonText = extArea.querySelector('#ext-f-json')?.value?.trim();
        if (!jsonText) { toast('请输入 JSON 配置', 'error'); return; }
        try {
          const parsed = JSON.parse(jsonText);
          const servers = parsed.mcpServers || parsed;
          const entries = Object.entries(servers);
          if (!entries.length) { toast('未找到服务器配置', 'error'); return; }

          for (const [name, config] of entries) {
            toast(`添加 ${name}...`, 'info');
            try {
              const result = await extApiCall('/api/external-servers', 'POST', { name, config });
              if (!result.ok) toast(`${name}: ${result.error || '失败'}`, 'error');
              else toast(`${name}: 已添加`, 'success');
            } catch (e) { toast(`${name}: ${e.message}`, 'error'); }
          }

          extFormOpen = false;
          renderExtTab();
          refreshMCPStatus();
        } catch (e) { toast(`JSON 解析失败: ${e.message}`, 'error'); }
      };
    }

    // Server start/stop/remove
    extArea.querySelectorAll('.ext-start').forEach(btn => {
      btn.onclick = async () => {
        const name = btn.dataset.name;
        try {
          const result = await extApiCall(`/api/external-servers/${encodeURIComponent(name)}/start`, 'POST');
          if (result.ok) { toast(`${name} 已启动`, 'success'); renderExtTab(); refreshMCPStatus(); }
          else toast(result.error || '启动失败', 'error');
        } catch (e) { toast(e.message, 'error'); }
      };
    });

    extArea.querySelectorAll('.ext-stop').forEach(btn => {
      btn.onclick = async () => {
        const name = btn.dataset.name;
        try {
          const result = await extApiCall(`/api/external-servers/${encodeURIComponent(name)}/stop`, 'POST');
          if (result.ok) { toast(`${name} 已停止`, 'success'); renderExtTab(); refreshMCPStatus(); }
          else toast(result.error || '停止失败', 'error');
        } catch (e) { toast(e.message, 'error'); }
      };
    });

    extArea.querySelectorAll('.ext-remove').forEach(btn => {
      btn.onclick = async () => {
        const name = btn.dataset.name;
        if (!confirm(`删除服务器「${name}」？`)) return;
        try {
          const result = await extApiCall(`/api/external-servers/${encodeURIComponent(name)}`, 'DELETE');
          if (result.ok) { toast(`${name} 已删除`, 'success'); renderExtTab(); refreshMCPStatus(); }
          else toast(result.error || '删除失败', 'error');
        } catch (e) { toast(e.message, 'error'); }
      };
    });

    // Refresh button
    extArea.querySelector('#ext-refresh')?.addEventListener('click', () => renderExtTab());
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Prompt Tab
  // ═══════════════════════════════════════════════════════════════════
  const promptText = panel.querySelector('#prompt-text');
  const promptStatus = panel.querySelector('#prompt-status');
  promptText.value = localStorage.getItem(LS_PROMPT) || '';

  panel.querySelector('#prompt-save').onclick = () => {
    const val = promptText.value.trim();
    localStorage.setItem(LS_PROMPT, val);
    if (val) { promptStatus.textContent = '已保存，下次对话生效'; toast('提示词已保存', 'success'); }
    else { promptStatus.textContent = '已清除'; toast('提示词已清除', 'info'); }
  };
  panel.querySelector('#prompt-clear').onclick = () => {
    promptText.value = '';
    localStorage.removeItem(LS_PROMPT);
    promptStatus.textContent = '已清除';
    toast('提示词已清除', 'info');
  };

  // ═══════════════════════════════════════════════════════════════════
  //  Settings Tab
  // ═══════════════════════════════════════════════════════════════════
  const cfgUrl = panel.querySelector('#cfg-url');
  const cfgSave = panel.querySelector('#cfg-save');

  // Module toggles
  ['mcp'].forEach(mod => {
    const toggle = panel.querySelector(`#mod-toggle-${mod}`);
    if (toggle) {
      toggle.onchange = () => {
        setModuleEnabled(mod, toggle.checked);
        toast(`${mod} 已${toggle.checked ? '启用' : '禁用'}`, 'info');
      };
    }
  });

  // Save settings
  cfgSave.onclick = () => {
    GM_setValue('mcp_url', cfgUrl.value.trim() || DEFAULT_MCP_URL);
    toast('设置已保存', 'success');
    refreshMCPStatus();
  };

  // ═══════════════════════════════════════════════════════════════════
  //  Initialization
  // ═══════════════════════════════════════════════════════════════════
  console.log(`${SCRIPT_PREFIX} DS Enhance v${VERSION} loaded — adapter: ${currentAdapter?.name || 'none'}`);

  }); // end waitForDOM
})();