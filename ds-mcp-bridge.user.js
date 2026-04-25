// ==UserScript==
// @name         DS MCP Bridge
// @namespace    https://github.com/calendar0917/ds-enhance
// @version      1.0.0
// @description  让 DeepSeek Chat 调用本地 MCP 工具（Shell、搜索等）
// @author       ds-enhance
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_PREFIX = '[Bridge]';
  const DEFAULT_MCP_URL = 'http://localhost:8024/mcp';

  // ═══════════════════════════════════════════════════════════════
  //  MCP Client (uses GM_xmlhttpRequest to bypass CORS)
  // ═══════════════════════════════════════════════════════════════
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
          method: 'POST',
          url: this.url,
          headers,
          data: JSON.stringify(body),
          onload: (resp) => {
            try {
              // Server might return SSE or JSON
              const text = resp.responseText;
              if (text.includes('text/event-stream') || resp.responseHeaders?.includes('text/event-stream')) {
                // Parse SSE response
                const lines = text.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    resolve(JSON.parse(line.slice(6)));
                    return;
                  }
                }
                reject(new Error('No data in SSE response'));
              } else {
                resolve(JSON.parse(text));
              }
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}`));
            }
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
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'ds-mcp-bridge', version: '1.0.0' },
        });
        this.sessionId = result.sessionId;
        this.connected = true;
        // Send initialized notification (no id = notification)
        await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        console.log(`${SCRIPT_PREFIX} MCP session initialized: ${this.sessionId}`);
        return true;
      } catch (e) {
        console.error(`${SCRIPT_PREFIX} Init failed:`, e.message);
        this.connected = false;
        return false;
      }
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
            method: 'GET',
            url: this.url.replace('/mcp', '/health'),
            onload: (r) => resolve(JSON.parse(r.responseText)),
            onerror: (e) => reject(e),
            timeout: 5000,
          });
        });
        return resp.status === 'ok';
      } catch {
        return false;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SSE Interceptor (must run at document-start)
  // ═══════════════════════════════════════════════════════════════
  const originalFetch = window.fetch;
  const pendingResponses = []; // {sessionId, resolve, buffer}

  // Tool call detection regex
  const TOOL_CALL_RE = /```mcp:(\w+)\n([\s\S]*?)```/g;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;
    if (!url || !url.includes('/api/v0/chat/completion')) {
      return response;
    }

    // Intercept the SSE stream
    const clone = response.clone();
    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const streamState = {
      fullContent: '',
      done: false,
      toolCalls: [],
    };

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events
          const parts = buffer.split('\n\n');
          buffer = parts.pop(); // Keep incomplete tail

          for (const part of parts) {
            for (const line of part.split('\n')) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                  streamState.done = true;
                  onStreamComplete(streamState);
                } else {
                  try {
                    const chunk = JSON.parse(data);
                    const content = chunk?.choices?.[0]?.delta?.content;
                    if (content) {
                      streamState.fullContent += content;
                    }
                  } catch { /* not JSON, skip */ }
                }
              }
            }
          }
        }
        // If we reach here without [DONE], check anyway
        if (!streamState.done && streamState.fullContent) {
          streamState.done = true;
          onStreamComplete(streamState);
        }
      } catch (e) {
        console.error(`${SCRIPT_PREFIX} SSE read error:`, e);
      }
    })();

    return response;
  };

  // ═══════════════════════════════════════════════════════════════
  //  Stream Complete Handler
  // ═══════════════════════════════════════════════════════════════
  function onStreamComplete(state) {
    const content = state.fullContent;
    if (!content) return;

    // Detect tool calls
    const toolCalls = [];
    let match;
    const re = new RegExp(TOOL_CALL_RE.source, 'g');
    while ((match = re.exec(content)) !== null) {
      const toolName = match[1];
      const rawArgs = match[2].trim();
      let args = {};
      try {
        args = JSON.parse(rawArgs);
      } catch {
        // Try as simple key=value or just a string
        args = { input: rawArgs };
      }
      toolCalls.push({ name: toolName, args });
    }

    if (toolCalls.length === 0) return;

    console.log(`${SCRIPT_PREFIX} Detected ${toolCalls.length} tool call(s):`, toolCalls.map(c => c.name));

    // Execute tool calls
    for (const call of toolCalls) {
      executeToolCall(call.name, call.args);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Tool Execution
  // ═══════════════════════════════════════════════════════════════
  const callHistory = [];
  let autoExecute = false; // Read from settings

  async function executeToolCall(toolName, args) {
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);
    const client = new MCPClient(mcpUrl);

    const record = {
      time: Date.now(),
      tool: toolName,
      args,
      status: 'running',
      result: null,
    };
    callHistory.unshift(record);
    if (callHistory.length > 50) callHistory.pop();

    try {
      if (!autoExecute) {
        // Notify user, wait for manual confirmation via panel
        notifyToolCall(record);
        return;
      }

      injectSystemMessage(`🔧 调用工具: ${toolName}\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``);

      const result = await client.callTool(toolName, args);
      const resultText = result?.content?.[0]?.text || '(no result)';
      const isError = result?.isError;

      record.status = isError ? 'error' : 'success';
      record.result = resultText;

      injectSystemMessage(
        `${isError ? '❌' : '✅'} 工具结果 (${toolName}):\n\`\`\`\n${resultText.substring(0, 2000)}\n\`\`\``
      );

      // Auto-send tool result as context for next AI response
      if (!isError) {
        autoSendToolResult(toolName, resultText);
      }

    } catch (e) {
      record.status = 'error';
      record.result = e.message;
      injectSystemMessage(`❌ 工具调用失败 (${toolName}): ${e.message}`);
    }
  }

  function notifyToolCall(record) {
    // Dispatch custom event for the panel to pick up
    window.dispatchEvent(new CustomEvent('dse-mcp-toolcall', { detail: record }));
    injectSystemMessage(`🔧 检测到工具调用: ${record.tool}（请在 DS Bridge 面板中确认执行）`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Message Injection
  // ═══════════════════════════════════════════════════════════════
  function injectSystemMessage(text) {
    // Find the chat messages container and append a system-style message
    const observer = new MutationObserver((mutations, obs) => {
      const chatArea = document.querySelector('[class*="message-list"]') ||
        document.querySelector('[class*="chat-message"]')?.parentElement;
      if (!chatArea) return;
      obs.disconnect();

      const div = document.createElement('div');
      div.style.cssText = `
        padding: 12px 16px; margin: 8px 16px; border-radius: 10px;
        background: #1a1a2e; border: 1px solid #2a2a3e;
        font-family: system-ui; font-size: 13px; color: #ccc;
        white-space: pre-wrap; word-break: break-all;
        max-width: 80%; opacity: 0.9;
      `;
      div.textContent = text;
      // Try to append to the chat area
      const lastChild = chatArea.lastElementChild;
      if (lastChild) lastChild.after(div);
      else chatArea.appendChild(div);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    // Also try immediately in case DOM is ready
    setTimeout(() => observer.disconnect(), 2000);

    console.log(`${SCRIPT_PREFIX} System: ${text.substring(0, 100)}`);
  }

  function autoSendToolResult(toolName, result) {
    // Hook the next fetch call to append tool result context
    const origFetch = window.fetch._original || originalFetch;
    let hooked = false;

    const hook = async function (...args) {
      if (!hooked) {
        hooked = true;
        window.fetch = origFetch; // Restore after one intercept

        const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;
        if (url && url.includes('/api/v0/chat/completion') && args[1]?.body) {
          try {
            const body = JSON.parse(args[1].body);
            if (body.messages) {
              body.messages.push({
                role: 'user',
                content: `[MCP 工具结果 - ${toolName}]\n${result}\n\n请基于以上工具执行结果继续回答。`,
              });
              args[1].body = JSON.stringify(body);
            }
          } catch { /* not JSON body, skip */ }
        }
      }
      return origFetch.apply(this, args);
    };
    hook._original = origFetch;
    window.fetch = hook;

    // Remove hook after 10s if not triggered
    setTimeout(() => {
      if (!hooked) window.fetch = origFetch;
    }, 10000);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Load UI after DOM is ready (deferred from document-start)
  // ═══════════════════════════════════════════════════════════════
  function waitForDOM() {
    return new Promise((resolve) => {
      if (document.body) resolve();
      else {
        const obs = new MutationObserver(() => {
          if (document.body) { obs.disconnect(); resolve(); }
        });
        obs.observe(document.documentElement, { childList: true });
      }
    });
  }

  waitForDOM().then(initUI);

  // ═══════════════════════════════════════════════════════════════
  //  UI (runs after DOM ready)
  // ═══════════════════════════════════════════════════════════════
  function initUI() {
    autoExecute = GM_getValue('auto_execute', false);
    const mcpUrl = GM_getValue('mcp_url', DEFAULT_MCP_URL);

    // ── Inject CSS ──
    const style = document.createElement('style');
    style.textContent = `
      #dse-fab{position:fixed;z-index:999999;width:48px;height:48px;border-radius:50%;background:#059669;color:#fff;border:none;font-size:22px;cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(5,150,105,.4);user-select:none;-webkit-user-select:none;touch-action:none}
      #dse-fab:active{cursor:grabbing}
      #dse-fab:hover{transform:scale(1.1);box-shadow:0 4px 20px rgba(5,150,105,.6)}
      #dse-fab.connected{background:#059669}
      #dse-fab.disconnected{background:#991b1b}

      #dse-panel{position:fixed;z-index:999998;width:460px;max-height:75vh;background:#16161e;color:#eee;border:1px solid #333;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;font-size:14px;display:none;flex-direction:column;overflow:hidden}
      #dse-panel.open{display:flex}
      #dse-panel .hd{padding:14px 18px;border-bottom:1px solid #2a2a3a;display:flex;align-items:center;justify-content:space-between}
      #dse-panel .hd h3{margin:0;font-size:15px;font-weight:600}
      #dse-panel .hd .cls{background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px}
      #dse-panel .hd .cls:hover{color:#fff}

      #dse-tabs{display:flex;border-bottom:1px solid #2a2a3a;overflow-x:auto;scrollbar-width:none}
      #dse-tabs::-webkit-scrollbar{display:none}
      #dse-tabs button{flex:0 0 auto;padding:9px 14px;background:none;border:none;color:#888;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
      #dse-tabs button.active{color:#7aa2f7;border-bottom-color:#7aa2f7}
      #dse-tabs button:hover{color:#ccc}

      .dse-bd{flex:1;overflow-y:auto;padding:12px 14px}
      .dse-section{display:none}.dse-section.active{display:block}

      .dse-actions{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
      .dse-actions button{padding:6px 12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;font-size:12px;cursor:pointer;transition:background .15s}
      .dse-actions button:hover{background:#333}
      .dse-actions button.pri{background:#059669;border-color:#059669;color:#fff}
      .dse-actions button.pri:hover{background:#10b981}
      .dse-actions button.dng{background:#7f1d1d;border-color:#991b1b}
      .dse-actions button.dng:hover{background:#991b1b}

      .dse-input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;box-sizing:border-box;outline:none}
      .dse-input:focus{border-color:#7aa2f7}
      .dse-input::placeholder{color:#555}

      .dse-sel{padding:7px 10px;border:1px solid #444;border-radius:8px;background:#1a1a28;color:#eee;font-size:13px;outline:none}

      .dse-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;transition:background .1s}
      .dse-row:hover{background:#1e1e2e}

      .dse-prog{font-size:13px;color:#aaa;padding:8px 0}
      .dse-prog .bar{height:4px;background:#333;border-radius:2px;margin-top:6px;overflow:hidden}
      .dse-prog .bar-i{height:100%;background:#059669;border-radius:2px;transition:width .2s}

      .dse-modal-bg{position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center}
      .dse-modal-box{background:#1a1a28;color:#eee;border-radius:14px;padding:0;min-width:380px;max-width:520px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;overflow:hidden}
      .dse-modal-box .mhd{padding:16px 20px;border-bottom:1px solid #2a2a3a;font-size:15px;font-weight:600}
      .dse-modal-box .mbd{padding:14px 20px;max-height:360px;overflow-y:auto}
      .dse-modal-box .mft{padding:12px 20px;border-top:1px solid #2a2a3a;display:flex;justify-content:flex-end;gap:8px}
      .dse-modal-box .mft button{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px}
      .dse-modal-box .mft .cancel{background:#333;color:#eee}.dse-modal-box .mft .cancel:hover{background:#444}
      .dse-modal-box .mft .confirm{background:#059669;color:#fff;font-weight:600}.dse-modal-box .mft .confirm:hover{background:#10b981}

      .dse-tool-card{padding:10px 12px;background:#1a1a28;border-radius:10px;margin-bottom:8px;border:1px solid #2a2a3a}
      .dse-tool-card h4{margin:0 0 4px;font-size:13px;color:#7aa2f7}
      .dse-tool-card p{margin:0;font-size:12px;color:#888}

      .dse-log-item{padding:8px 10px;border-radius:8px;margin-bottom:6px;font-size:12px;border:1px solid #2a2a3a}
      .dse-log-item .log-head{display:flex;justify-content:space-between;margin-bottom:4px}
      .dse-log-item .log-tool{color:#7aa2f7;font-weight:600}
      .dse-log-item .log-time{color:#555}
      .dse-log-item .log-status{padding:1px 6px;border-radius:4px;font-size:11px}
      .dse-log-item .log-status.success{background:#0d3320;color:#6ee7b7}
      .dse-log-item .log-status.error{background:#3d0f0f;color:#fca5a5}
      .dse-log-item .log-status.running{background:#1a2a4a;color:#7aa2f7}
      .dse-log-item .log-args{color:#888;font-size:11px;white-space:pre-wrap;word-break:break-all}

      .dse-status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
      .dse-status-dot.green{background:#10b981}
      .dse-status-dot.red{background:#ef4444}
      .dse-status-dot.yellow{background:#f59e0b}
    `;
    document.head.appendChild(style);

    // ── FAB ──
    const fab = document.createElement('button');
    fab.id = 'dse-fab';
    fab.innerHTML = '&#9881;';
    fab.title = 'DS MCP Bridge (可拖动)';
    fab.className = 'disconnected';
    document.body.appendChild(fab);

    // ── Panel ──
    const panel = document.createElement('div');
    panel.id = 'dse-panel';
    panel.innerHTML = `
      <div class="hd"><h3>DS MCP Bridge</h3><button class="cls">&times;</button></div>
      <div id="dse-tabs">
        <button class="active" data-tab="status">MCP 状态</button>
        <button data-tab="history">调用历史</button>
        <button data-tab="settings">设置</button>
      </div>
      <div class="dse-bd">
        <!-- Status -->
        <div id="sec-status" class="dse-section active">
          <div id="mcp-conn-status" style="margin-bottom:12px;font-size:13px">
            <span class="dse-status-dot yellow"></span>检测中...
          </div>
          <div class="dse-actions">
            <button id="mcp-connect">连接服务器</button>
            <button id="mcp-refresh">刷新工具列表</button>
          </div>
          <div id="mcp-tools-list"></div>
        </div>

        <!-- History -->
        <div id="sec-history" class="dse-section">
          <div class="dse-actions">
            <button id="hist-clear">清空历史</button>
          </div>
          <div id="hist-list"></div>
        </div>

        <!-- Settings -->
        <div id="sec-settings" class="dse-section">
          <div style="margin-bottom:12px">
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px">MCP 服务器地址</label>
            <input type="text" id="cfg-url" class="dse-input" value="${mcpUrl}">
          </div>
          <div style="margin-bottom:12px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
              <input type="checkbox" id="cfg-auto" ${autoExecute ? 'checked' : ''} style="width:16px;height:16px">
              自动执行工具调用（不需确认）
            </label>
            <div style="font-size:11px;color:#666;margin-top:4px;margin-left:24px">
              关闭时，检测到工具调用会通知你，需在面板中手动确认
            </div>
          </div>
          <div class="dse-actions">
            <button id="cfg-save" class="pri">保存设置</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // ── Drag Logic ──
    let fabDragged = false, fabSX, fabSY, fabOX, fabOY;
    const DRAG_TH = 5;

    function posPanel() {
      const r = fab.getBoundingClientRect();
      let l = r.left;
      if (l + 460 > innerWidth - 10) l = innerWidth - 470;
      if (l < 10) l = 10;
      panel.style.left = l + 'px';
      panel.style.bottom = (innerHeight - r.top + 10) + 'px';
      panel.style.top = 'auto';
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
        if (!fabDragged) { panel.classList.toggle('open'); if (panel.classList.contains('open')) posPanel(); }
        else if (panel.classList.contains('open')) posPanel();
      };
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
      e.preventDefault();
    });

    fab.style.left = '80px';
    fab.style.top = (innerHeight - 68) + 'px';

    panel.querySelector('.cls').onclick = () => panel.classList.remove('open');

    // ── Tab Switching ──
    panel.querySelectorAll('#dse-tabs button').forEach(btn => {
      btn.onclick = () => {
        panel.querySelectorAll('#dse-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        panel.querySelectorAll('.dse-section').forEach(s => s.classList.remove('active'));
        panel.querySelector(`#sec-${tab}`).classList.add('active');
        if (tab === 'status') refreshStatus();
        if (tab === 'history') renderHistory();
      };
    });

    // ── Status Tab ──
    const statusEl = panel.querySelector('#mcp-conn-status');
    const toolsListEl = panel.querySelector('#mcp-tools-list');

    async function refreshStatus() {
      const url = panel.querySelector('#cfg-url')?.value || GM_getValue('mcp_url', DEFAULT_MCP_URL);
      const client = new MCPClient(url);

      statusEl.innerHTML = '<span class="dse-status-dot yellow"></span>检测中...';
      toolsListEl.innerHTML = '';

      const healthy = await client.checkHealth();
      if (!healthy) {
        statusEl.innerHTML = '<span class="dse-status-dot red"></span>服务器未连接（请确保 server.py 正在运行）';
        fab.className = 'disconnected';
        return;
      }

      try {
        await client.initialize();
        const tools = await client.listTools();
        statusEl.innerHTML = `<span class="dse-status-dot green"></span>已连接 (${tools.length} 个工具)`;
        fab.className = 'connected';

        tools.forEach(t => {
          const card = document.createElement('div');
          card.className = 'dse-tool-card';
          card.innerHTML = `<h4>${t.name}</h4><p>${t.description || ''}</p>`;
          toolsListEl.appendChild(card);
        });
      } catch (e) {
        statusEl.innerHTML = `<span class="dse-status-dot red"></span>连接失败: ${e.message}`;
        fab.className = 'disconnected';
      }
    }

    panel.querySelector('#mcp-connect').onclick = refreshStatus;
    panel.querySelector('#mcp-refresh').onclick = refreshStatus;

    // ── History Tab ──
    const histListEl = panel.querySelector('#hist-list');

    function renderHistory() {
      histListEl.innerHTML = '';
      if (!callHistory.length) {
        histListEl.innerHTML = '<div style="color:#555;font-size:13px;padding:12px 0">暂无调用记录</div>';
        return;
      }
      callHistory.forEach(r => {
        const item = document.createElement('div');
        item.className = 'dse-log-item';
        const time = new Date(r.time);
        const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;
        item.innerHTML = `
          <div class="log-head">
            <span class="log-tool">${r.tool}</span>
            <span>
              <span class="log-status ${r.status}">${r.status}</span>
              <span class="log-time">${timeStr}</span>
            </span>
          </div>
          <div class="log-args">${esc(JSON.stringify(r.args))}</div>
          ${r.result ? `<div class="log-args" style="margin-top:4px;color:#6ee7b7">${esc(r.result.substring(0, 200))}</div>` : ''}
        `;
        histListEl.appendChild(item);
      });
    }

    panel.querySelector('#hist-clear').onclick = () => {
      callHistory.length = 0;
      renderHistory();
    };

    // ── Settings Tab ──
    panel.querySelector('#cfg-save').onclick = () => {
      const url = panel.querySelector('#cfg-url').value.trim();
      const auto = panel.querySelector('#cfg-auto').checked;
      GM_setValue('mcp_url', url);
      GM_setValue('auto_execute', auto);
      autoExecute = auto;
      toast('设置已保存', 'success');
      refreshStatus();
    };

    // ── Listen for tool call notifications ──
    window.addEventListener('dse-mcp-toolcall', (e) => {
      renderHistory();
      // If panel is not open, show a brief notification
      if (!panel.classList.contains('open')) {
        toast(`检测到工具调用: ${e.detail.tool}`, 'info');
      }
    });

    // ── Keyboard shortcut ──
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) posPanel();
      }
    });

    // ── Initial status check ──
    setTimeout(refreshStatus, 1000);

    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    console.log(`${SCRIPT_PREFIX} DS MCP Bridge v1.0.0 loaded — 按钮在左下角 (绿色)，或 Ctrl+Shift+M`);
  }
})();
