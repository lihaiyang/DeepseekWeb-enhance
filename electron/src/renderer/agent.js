/**
 * DS Agent — Renderer Script (Agent Core)
 *
 * This is the core agent logic injected into the chat page.
 * It replaces the original userscript's MCP bridge functionality
 * and adds the multi-turn Agentic Loop.
 *
 * IMPORTANT: This script is injected via <script> tag from preload.js,
 * so it runs in the MAIN WORLD (page context) where window.dsAgent
 * is available via contextBridge.
 *
 * Network hooks (fetch/XHR) are ALREADY installed by preload.js
 * before this script runs. This script registers its tool detection
 * and execution callbacks via window.__dsAgentCheckToolCalls and
 * window.__dsAgentRunLoop.
 */

(function () {
  'use strict';

  const PREFIX = '[DS Agent]';
  const VERSION = '1.0.0';
  const TOOL_CALL_RE = /```mcp:(\w+)\n([\s\S]*?)```/g;
  const MAX_AGENT_LOOPS = 10;

  // ─── State ──────────────────────────────────────────────────
  let toolRegistry = [];
  let agentRunning = false;
  let agentAbortController = null;
  let executedCalls = new Set();
  let toolFiles = [];
  let agentStepCount = 0;
  let currentToolHint = '';

  // ─── UI: Floating Panel ────────────────────────────────────
  let panel = null;

  function createPanel() {
    if (document.getElementById('ds-agent-panel')) return;

    panel = document.createElement('div');
    panel.id = 'ds-agent-panel';
    panel.innerHTML = `
      <div id="ds-agent-header">
        <span>🤖 DS Agent</span>
        <div id="ds-agent-header-actions">
          <button id="ds-agent-stop" title="停止 Agent" style="display:none">⏹</button>
          <button id="ds-agent-toggle-panel" title="控制面板">⚙️</button>
          <button id="ds-agent-close" title="关闭">✕</button>
        </div>
      </div>
      <div id="ds-agent-body">
        <div id="ds-agent-status">
          <div class="ds-agent-status-row">
            <span>连接状态</span>
            <span id="ds-agent-conn-status">检测中...</span>
          </div>
          <div class="ds-agent-status-row">
            <span>工具数量</span>
            <span id="ds-agent-tool-count">0</span>
          </div>
          <div class="ds-agent-status-row">
            <span>Agent 状态</span>
            <span id="ds-agent-loop-status">空闲</span>
          </div>
        </div>
        <div id="ds-agent-steps"></div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #ds-agent-panel {
        position: fixed; bottom: 20px; left: 20px; z-index: 99999;
        width: 360px; max-height: 500px;
        background: #1e1e2e; color: #cdd6f4; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4); font-family: -apple-system, sans-serif;
        font-size: 13px; overflow: hidden; transition: all 0.3s ease;
      }
      #ds-agent-panel.hidden { transform: translateY(calc(100% - 40px)); }
      #ds-agent-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 12px; background: #313244; cursor: pointer;
      }
      #ds-agent-header span { font-weight: 600; }
      #ds-agent-header-actions { display: flex; gap: 4px; }
      #ds-agent-header-actions button {
        background: none; border: none; color: #cdd6f4; cursor: pointer;
        padding: 2px 6px; border-radius: 4px; font-size: 14px;
      }
      #ds-agent-header-actions button:hover { background: #45475a; }
      #ds-agent-stop { color: #f38ba8 !important; }
      #ds-agent-body { padding: 10px 12px; max-height: 440px; overflow-y: auto; }
      .ds-agent-status-row {
        display: flex; justify-content: space-between; padding: 4px 0;
        border-bottom: 1px solid #313244;
      }
      .ds-agent-status-row span:first-child { color: #a6adc8; }
      #ds-agent-steps { margin-top: 8px; }
      .ds-agent-step {
        padding: 6px 8px; margin: 4px 0; border-radius: 6px;
        background: #313244; font-size: 12px; line-height: 1.4;
      }
      .ds-agent-step.tool { border-left: 3px solid #89b4fa; }
      .ds-agent-step.result { border-left: 3px solid #a6e3a1; }
      .ds-agent-step.error { border-left: 3px solid #f38ba8; }
      .ds-agent-step.thinking { border-left: 3px solid #f9e2af; }
      .ds-agent-step .step-label { font-weight: 600; margin-bottom: 2px; }
      .ds-agent-step .step-content { color: #a6adc8; word-break: break-all; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);

    document.getElementById('ds-agent-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    document.getElementById('ds-agent-toggle-panel').addEventListener('click', () => {
      window.dsAgent?.openControlPanel();
    });
    document.getElementById('ds-agent-stop').addEventListener('click', () => {
      stopAgentLoop();
    });
    document.getElementById('ds-agent-header').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      panel.classList.toggle('hidden');
    });
  }

  function updateStatus(elementId, text) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = text;
  }

  function addStep(type, label, content) {
    const steps = document.getElementById('ds-agent-steps');
    if (!steps) return;
    const step = document.createElement('div');
    step.className = `ds-agent-step ${type}`;
    step.innerHTML = `<div class="step-label">${label}</div><div class="step-content">${escapeHtml(content)}</div>`;
    steps.appendChild(step);
    steps.scrollTop = steps.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Tool Registry ─────────────────────────────────────────

  async function refreshToolRegistry() {
    try {
      const result = await window.dsAgent.listTools();
      if (result.success) {
        toolRegistry = result.data || [];
        updateStatus('ds-agent-tool-count', toolRegistry.length.toString());
        updateToolHint();
        console.log(`${PREFIX} Tools loaded: ${toolRegistry.map(t => t.name).join(', ')}`);
      }
    } catch (err) {
      console.error(`${PREFIX} Failed to load tools:`, err);
    }
  }

  function buildToolHint() {
    if (!toolRegistry.length) return '';

    let hint = '[系统指令] 你是一个能操作用户电脑的 AI 助手。你拥有以下 MCP 工具，当用户的需求可以用工具完成时，你必须调用工具。\n\n';
    hint += '调用格式：用代码块写 ```mcp:工具名``` 后紧跟一个 JSON 代码块写参数。\n\n';
    hint += '示例：\n```mcp:execute_command\n{"command": "ls -la"}\n```\n\n';
    hint += '可用工具列表：\n';

    toolRegistry.forEach(t => {
      hint += `\n### ${t.name}\n${t.description || ''}\n`;
      const schema = t.inputSchema;
      if (schema?.properties) {
        const props = Object.entries(schema.properties);
        if (props.length) {
          hint += '参数:\n';
          props.forEach(([key, val]) => {
            const required = schema.required?.includes(key) ? ' (必填)' : ' (可选)';
            hint += `  - ${key}${required}: ${val.description || val.type || ''}\n`;
          });
        }
      }
    });

    hint += '\n\n## 行为规范';
    hint += '\n- 如果用户的需求需要多步操作，请逐步调用工具，每次调用一个';
    hint += '\n- 如果工具返回错误，请分析原因并尝试其他方法';
    hint += '\n- 执行完所有必要操作后，请给出清晰的总结';
    hint += '\n- 如果不需要工具就正常回答';
    hint += '\n\n当收到 <tool_result> 包裹的文本时，这是你之前调用的工具的执行结果。请基于结果继续回答用户的问题，或决定是否需要调用更多工具。';
    return hint;
  }

  function updateToolHint() {
    currentToolHint = buildToolHint();
    // Update the early hook's tool hint
    window.__dsAgentToolHint = currentToolHint;
    // Also notify main process (backup)
    window.dsAgent?.updateToolHint(currentToolHint);
  }

  // ─── Tool Call Detection ───────────────────────────────────

  function checkForToolCalls(content) {
    if (!content || !toolRegistry.length) return [];

    const calls = [];
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
      calls.push({ name: toolName, args });
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
      calls.push({ name, args });
    }

    return calls;
  }

  // ─── Agentic Loop ──────────────────────────────────────────

  async function runAgenticLoop(toolCalls) {
    if (agentRunning) {
      console.log(`${PREFIX} Agent already running, skipping`);
      return;
    }

    agentRunning = true;
    agentAbortController = new AbortController();
    agentStepCount = 0;
    executedCalls.clear();

    updateStatus('ds-agent-loop-status', '🔄 运行中');
    const stopBtn = document.getElementById('ds-agent-stop');
    if (stopBtn) stopBtn.style.display = 'inline-block';

    try {
      let pendingCalls = [...toolCalls];

      while (pendingCalls.length > 0 && agentStepCount < MAX_AGENT_LOOPS) {
        if (agentAbortController.signal.aborted) {
          addStep('thinking', '⏹ 已停止', '用户手动停止了 Agent');
          break;
        }

        for (const call of pendingCalls) {
          if (agentAbortController.signal.aborted) break;

          agentStepCount++;
          addStep('tool', `🔧 步骤 ${agentStepCount}: ${call.name}`, JSON.stringify(call.args, null, 2).slice(0, 200));

          try {
            const result = await window.dsAgent.callTool(call.name, call.args);

            const resultText = result.data?.content?.[0]?.text || '(no result)';
            const isError = result.data?.isError || false;

            addStep(
              isError ? 'error' : 'result',
              isError ? '❌ 执行失败' : '✅ 执行成功',
              String(resultText).slice(0, 300)
            );

            // Handle file results
            if (!isError && (call.name === 'read_file' || call.name === 'list_directory')) {
              const filename = (call.args.path || 'tool_result.txt').split('/').pop().split('\\').pop();
              toolFiles.push({ filename, text: resultText, mimeType: 'text/plain' });
              window.__dsAgentToolFiles = toolFiles;
              addStep('thinking', '📁 文件上下文', `${filename} 已添加到文件列表`);
            }

            // Inject result into chat
            await injectToolResult(call.name, resultText, isError);
          } catch (err) {
            addStep('error', '❌ 异常', err.message);
            await injectToolResult(call.name, err.message, true);
          }

          await sleep(500);
        }

        // After injecting results, the AI will generate a new response.
        // The early network hooks will detect new tool calls and call runAgenticLoop again.
        break;
      }

      if (agentStepCount >= MAX_AGENT_LOOPS) {
        addStep('thinking', '⚠️ 达到上限', `已执行 ${MAX_AGENT_LOOPS} 步，自动停止`);
      }
    } finally {
      agentRunning = false;
      agentAbortController = null;
      updateStatus('ds-agent-loop-status', '空闲');
      const stopBtn2 = document.getElementById('ds-agent-stop');
      if (stopBtn2) stopBtn2.style.display = 'none';
    }
  }

  function stopAgentLoop() {
    if (agentAbortController) {
      agentAbortController.abort();
      agentRunning = false;
      updateStatus('ds-agent-loop-status', '⏹ 已停止');
      addStep('thinking', '⏹ 已停止', '用户手动停止了 Agent');
    }
  }

  // ─── Result Injection ──────────────────────────────────────

  async function injectToolResult(toolName, resultText, isError) {
    const wrappedText = `<tool_result>\n${isError ? 'Error: ' : ''}${resultText}\n</tool_result>`;

    const input = findInputElement();
    if (!input) {
      console.error(`${PREFIX} Cannot find input element`);
      return;
    }

    input.focus();
    await sleep(200);
    setInputValue(input, wrappedText);
    await sleep(300);

    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.click();
      console.log(`${PREFIX} Tool result injected and sent`);
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    await sleep(500);
  }

  // ─── DOM Helpers ───────────────────────────────────────────

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
      'button[type="submit"]',
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
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      sel.removeAllRanges();
      sel.addRange(range);

      try { document.execCommand('insertText', false, value); }
      catch { element.textContent = value; }

      range.selectNodeContents(element);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(element, value);
      } else {
        element.value = value;
      }
    }

    element.dispatchEvent(new InputEvent('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Keyboard Shortcuts ────────────────────────────────────

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        if (panel) {
          panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        stopAgentLoop();
      }
    });
  }

  // ─── Init ──────────────────────────────────────────────────

  async function init() {
    console.log(`${PREFIX} v${VERSION} initializing...`);

    if (document.readyState !== 'complete') {
      await new Promise(resolve => window.addEventListener('load', resolve));
    }

    await sleep(1000);

    // 1. Create UI
    createPanel();

    // 2. Check tool handler connection (IPC, no HTTP)
    try {
      const health = await window.dsAgent.health();
      updateStatus('ds-agent-conn-status', health.success ? '✅ 已就绪' : '❌ 未就绪');
    } catch {
      updateStatus('ds-agent-conn-status', '❌ 未就绪');
    }

    // 3. Load tool registry
    await refreshToolRegistry();

    // 4. Register callbacks for the early network hooks
    window.__dsAgentCheckToolCalls = checkForToolCalls;
    window.__dsAgentRunLoop = runAgenticLoop;
    console.log(`${PREFIX} Network hook callbacks registered`);

    // 5. Setup keyboard shortcuts
    setupKeyboardShortcuts();

    console.log(`${PREFIX} Ready — ${toolRegistry.length} tools available`);
    addStep('thinking', '🚀 Agent 已就绪', `加载了 ${toolRegistry.length} 个工具，等待指令...`);
  }

  // ─── Entry Point ───────────────────────────────────────────

  if (window.dsAgent) {
    init();
  } else {
    console.warn(`${PREFIX} window.dsAgent not available yet, retrying...`);
    let retries = 0;
    const retryInterval = setInterval(() => {
      retries++;
      if (window.dsAgent) {
        clearInterval(retryInterval);
        init();
      } else if (retries > 10) {
        clearInterval(retryInterval);
        console.error(`${PREFIX} window.dsAgent never became available — preload may have failed`);
      }
    }, 500);
  }
})();
