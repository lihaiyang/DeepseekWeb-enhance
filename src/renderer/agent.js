/**
 * DS Agent — Renderer Script (Agent Core)
 *
 * Injected into the DeepSeek chat page via <script> tag from preload.js.
 * Runs in the MAIN WORLD where window.dsAgent (contextBridge) is available.
 *
 * The panel now supports 3 modes:
 *   - compact: floating 360×500 bottom-right (original behavior)
 *   - half:     right 45% of viewport, full height
 *   - full:     100% viewport (DeepSeek page hidden behind)
 *
 * In half/full mode, a custom chat UI (messages + input) proxies messages
 * into the DeepSeek page and displays AI responses in real time.
 */

(function () {
  'use strict';

  const PREFIX = '[DS Agent]';
  const VERSION = '1.0.0';
  const TOOL_CALL_RE = /```mcp:(\w+)\n([\s\S]*?)```/g;
  let maxAgentLoops = 100; // Default, overridden by config 'max_steps'

  // ─── State ──────────────────────────────────────────────────
  let toolRegistry = [];
  let agentRunning = false;
  let agentAbortController = null;
  let executedCalls = new Set();
  let agentStepCount = 0;
  let currentToolHint = '';
  let panelMode = 'full';           // compact | half | full
  let panelVisible = false;          // Start hidden, show after login detected
  let contextPanel = null;           // Right-side context panel
  let contextTab = 'files';          // 'files' | 'preview' | 'stats'
  let fileTreeData = null;           // Cached file tree from list_dir
  let workspacePath = '';            // Current workspace path
  let previewFilePath = '';          // Current file being previewed (full path)
  let previewContent = '';           // Content of previewed file
  let totalInputChars = 0;           // Total chars sent to model (for token estimation)
  let totalOutputChars = 0;          // Total chars received from model
  let currentAiBubble = null;       // Reference to AI message bubble being streamed
  let currentAiContent = '';        // Accumulated AI response text
  let currentThinkingBubble = null; // Reference to thinking bubble
  let currentThinkingContent = '';  // Accumulated thinking text
  let thinkingExpanded = true;      // Whether thinking bubble is expanded
  let lastStreamType = null;        // 'thinking' | 'response' | null — tracks current stream phase for interleaved think/response
  let isComposing = false;          // IME composition state (Chinese/Japanese input)
  let currentTheme = 'dark';         // 'dark' | 'light'
  let userScrolledUp = false;       // Whether user has manually scrolled up (pause auto-scroll)
  let scrollToBottomBtn = null;     // "Scroll to bottom" button

  // ─── UI Elements (populated in createPanel) ──────────────────
  let panel = null;
  let fabButton = null;
  let messagesContainer = null;
  let inputArea = null;
  let inputTextarea = null;
  let sendButton = null;
  let stepsContainer = null;
  let statusContainer = null;

  // ─── Create Panel UI ─────────────────────────────────────────

  function createPanel() {
    if (document.getElementById('ds-agent-panel')) return;

    // Main panel
    panel = document.createElement('div');
    panel.id = 'ds-agent-panel';

    // Header
    const header = document.createElement('div');
    header.id = 'ds-agent-header';
    header.innerHTML = `<span>🤖 DS Agent</span>`;

    const headerActions = document.createElement('div');
    headerActions.id = 'ds-agent-header-actions';

    // Theme toggle button
    const themeBtn = document.createElement('button');
    themeBtn.id = 'ds-agent-theme-toggle';
    themeBtn.title = '切换亮色/暗色主题';
    themeBtn.textContent = '☀️';
    themeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTheme();
    });
    headerActions.appendChild(themeBtn);

    // Mode toggle button
    const modeBtn = document.createElement('button');
    modeBtn.id = 'ds-agent-mode-toggle';
    modeBtn.title = '切换面板模式';
    modeBtn.textContent = '⧉';
    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cyclePanelMode();
    });
    headerActions.appendChild(modeBtn);

    // New conversation button
    const newChatBtn = document.createElement('button');
    newChatBtn.id = 'ds-agent-new-chat';
    newChatBtn.title = '新建会话';
    newChatBtn.textContent = '➕';
    newChatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      newConversation();
    });
    headerActions.appendChild(newChatBtn);

    // Stop agent button
    const stopBtn = document.createElement('button');
    stopBtn.id = 'ds-agent-stop';
    stopBtn.title = '停止 Agent';
    stopBtn.textContent = '⏹';
    stopBtn.style.display = 'none';
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      stopAgentLoop();
    });
    headerActions.appendChild(stopBtn);

    // Control panel button
    const cpBtn = document.createElement('button');
    cpBtn.id = 'ds-agent-toggle-panel';
    cpBtn.title = '控制面板';
    cpBtn.textContent = '⚙';
    cpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dsAgent?.openControlPanel();
    });
    headerActions.appendChild(cpBtn);

    // Minimize/close button
    const minimizeBtn = document.createElement('button');
    minimizeBtn.id = 'ds-agent-minimize';
    minimizeBtn.title = '最小化 / 关闭面板';
    minimizeBtn.textContent = '─';
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hidePanel();
    });
    headerActions.appendChild(minimizeBtn);

    header.appendChild(headerActions);

    // Body
    const body = document.createElement('div');
    body.id = 'ds-agent-body';

    // Messages area (chat bubbles, visible in half/full)
    messagesContainer = document.createElement('div');
    messagesContainer.id = 'ds-agent-messages';

    // Status area (visible in compact mode)
    statusContainer = document.createElement('div');
    statusContainer.id = 'ds-agent-status';
    statusContainer.innerHTML = `
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
    `;

    // Steps log (tool execution, visible in compact mode)
    stepsContainer = document.createElement('div');
    stepsContainer.id = 'ds-agent-steps';

    // Chat column (left side): messages + input
    const chatColumn = document.createElement('div');
    chatColumn.id = 'ds-agent-chat-column';
    chatColumn.appendChild(messagesContainer);

    // Resize handle (draggable divider between chat and context)
    const resizeHandle = document.createElement('div');
    resizeHandle.id = 'ds-agent-resize-handle';

    body.appendChild(chatColumn);
    body.appendChild(resizeHandle);
    body.appendChild(statusContainer);
    body.appendChild(stepsContainer);

    // Scroll-to-bottom button (appears when user scrolls up during streaming)
    scrollToBottomBtn = document.createElement('button');
    scrollToBottomBtn.id = 'ds-agent-scroll-bottom';
    scrollToBottomBtn.title = '滚动到底部';
    scrollToBottomBtn.innerHTML = '↓';
    scrollToBottomBtn.addEventListener('click', () => {
      userScrolledUp = false;
      scrollToBottomBtn.style.display = 'none';
      scrollMessagesToBottom();
    });
    scrollToBottomBtn.style.display = 'none'; // hidden by default
    messagesContainer.appendChild(scrollToBottomBtn);

    // Scroll listener: detect when user manually scrolls up
    let lastScrollTop = 0;
    messagesContainer.addEventListener('scroll', () => {
      const currentScrollTop = messagesContainer.scrollTop;
      const atBottom = messagesContainer.scrollHeight - currentScrollTop - messagesContainer.clientHeight < 40;
      // User scrolled up (scrollTop decreased) → immediately stop auto-scroll
      if (currentScrollTop < lastScrollTop - 2) {
        userScrolledUp = true;
        if (scrollToBottomBtn) scrollToBottomBtn.style.display = 'flex';
      } else if (atBottom) {
        userScrolledUp = false;
        if (scrollToBottomBtn) scrollToBottomBtn.style.display = 'none';
      }
      lastScrollTop = currentScrollTop;
    });

    // Right context panel (visible in full mode)
    contextPanel = document.createElement('div');
    contextPanel.id = 'ds-agent-context-panel';
    contextPanel.innerHTML = `
      <div id="ds-agent-context-tabs">
        <button class="ds-context-tab active" data-tab="files">📁 文件</button>
        <button class="ds-context-tab" data-tab="preview">📄 预览</button>
        <button class="ds-context-tab" data-tab="stats">📊 统计</button>
      </div>
      <div id="ds-agent-context-content">
        <div class="ds-context-pane active" data-pane="files">
          <div id="ds-agent-file-tree">
            <div class="context-empty">等待 Agent 浏览文件...</div>
          </div>
        </div>
        <div class="ds-context-pane" data-pane="preview">
          <div id="ds-agent-file-preview">
            <div class="context-empty">选择文件以预览内容</div>
          </div>
        </div>
        <div class="ds-context-pane" data-pane="stats">
          <div id="ds-agent-stats-panel"></div>
        </div>
      </div>
    `;
    body.appendChild(contextPanel);

    // ── Resize handle drag logic ──
    let splitRatio = 0.6; // default 6:4
    let isDragging = false;

    resizeHandle.addEventListener('mousedown', function(e) {
      if (panelMode === 'compact') return;
      e.preventDefault();
      isDragging = true;
      resizeHandle.classList.add('active');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    });

    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;
      var bodyRect = body.getBoundingClientRect();
      var x = e.clientX - bodyRect.left;
      splitRatio = Math.max(0.3, Math.min(0.8, x / bodyRect.width));
      chatColumn.style.flex = '0 0 ' + (splitRatio * 100) + '%';
      chatColumn.style.maxWidth = (splitRatio * 100) + '%';
    });

    document.addEventListener('mouseup', function() {
      if (!isDragging) return;
      isDragging = false;
      resizeHandle.classList.remove('active');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    });

    // Wire up context tab clicks
    setTimeout(() => {
      const tabs = contextPanel.querySelectorAll('.ds-context-tab');
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          contextTab = tab.dataset.tab;
          tabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          const panes = contextPanel.querySelectorAll('.ds-context-pane');
          panes.forEach(p => p.classList.remove('active'));
          contextPanel.querySelector('[data-pane="' + contextTab + '"]')?.classList.add('active');
        });
      });
    }, 0);

    // Input area (visible in half/full mode)
    inputArea = document.createElement('div');
    inputArea.id = 'ds-agent-input-area';
    inputArea.innerHTML = `
      <textarea id="ds-agent-input" placeholder="输入消息，Enter 发送，Shift+Enter 换行..." rows="1"></textarea>
      <button id="ds-agent-send" title="发送">➤</button>
    `;

    // Input area goes inside chat column, not directly in panel
    chatColumn.appendChild(inputArea);

    panel.appendChild(header);
    panel.appendChild(body);

    // FAB button (shown when panel is closed)
    fabButton = document.createElement('button');
    fabButton.id = 'ds-agent-fab';
    fabButton.textContent = '🤖';
    fabButton.title = '打开 DS Agent';
    fabButton.addEventListener('click', () => showPanel());

    // Inject styles
    injectStyles();

    document.body.appendChild(panel);
    document.body.appendChild(fabButton);

    // Wire up events
    setupPanelEvents();

    // Set initial mode
    applyPanelMode();

    // Start hidden if panelVisible is false (login-first flow)
    if (!panelVisible) {
      hidePanel();
    }
  }

  // ─── CSS Styles ──────────────────────────────────────────────

  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'ds-agent-styles';
    style.textContent = `
      /* ===== Theme: Dark (Catppuccin Mocha) ===== */
      body[data-ds-agent-theme="dark"] {
        --ds-bg-base: #1e1e2e;
        --ds-bg-mantle: #181825;
        --ds-bg-crust: #11111b;
        --ds-bg-surface0: #313244;
        --ds-bg-surface1: #45475a;
        --ds-bg-surface2: #585b70;
        --ds-bg-stats-card: #1e2030;
        --ds-bg-hover: #252535;
        --ds-text-primary: #cdd6f4;
        --ds-text-secondary: #a6adc8;
        --ds-text-code: #bac2de;
        --ds-text-muted: #6c7086;
        --ds-text-on-accent: #1e1e2e;
        --ds-accent-blue: #89b4fa;
        --ds-accent-sky: #74c7ec;
        --ds-accent-mauve: #cba6f7;
        --ds-accent-green: #a6e3a1;
        --ds-accent-red: #f38ba8;
        --ds-accent-maroon: #eba0ac;
        --ds-accent-yellow: #f9e2af;
        --ds-shadow: 0 8px 32px rgba(0,0,0,0.5);
        --ds-shadow-fab: 0 4px 16px rgba(0,0,0,0.3);
        --ds-shadow-scroll: 0 2px 8px rgba(0,0,0,0.3);
        --ds-border-subtle: rgba(49, 50, 68, 0.4);
      }
      /* ===== Theme: Light (Catppuccin Latte) ===== */
      body[data-ds-agent-theme="light"] {
        --ds-bg-base: #eff1f5;
        --ds-bg-mantle: #e6e9ef;
        --ds-bg-crust: #dce0e8;
        --ds-bg-surface0: #ccd0da;
        --ds-bg-surface1: #bcc0cc;
        --ds-bg-surface2: #acb0be;
        --ds-bg-stats-card: #e6e9ef;
        --ds-bg-hover: #e6e9ef;
        --ds-text-primary: #4c4f69;
        --ds-text-secondary: #5c5f77;
        --ds-text-code: #6c6f85;
        --ds-text-muted: #9ca0b0;
        --ds-text-on-accent: #ffffff;
        --ds-accent-blue: #1e66f5;
        --ds-accent-sky: #04a5e5;
        --ds-accent-mauve: #8839ef;
        --ds-accent-green: #40a02b;
        --ds-accent-red: #d20f39;
        --ds-accent-maroon: #e64553;
        --ds-accent-yellow: #df8e1d;
        --ds-shadow: 0 8px 32px rgba(0,0,0,0.12);
        --ds-shadow-fab: 0 4px 16px rgba(0,0,0,0.1);
        --ds-shadow-scroll: 0 2px 8px rgba(0,0,0,0.1);
        --ds-border-subtle: rgba(204, 208, 218, 0.4);
      }

      /* ===== Base Panel ===== */
      #ds-agent-panel {
        position: fixed; z-index: 99999;
        background: var(--ds-bg-base); color: var(--ds-text-primary);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; display: flex; flex-direction: column;
        box-shadow: var(--ds-shadow);
        transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        border-radius: 12px; overflow: hidden;
      }
      #ds-agent-panel.mode-compact {
        width: 360px; max-height: 500px;
        bottom: 20px; right: 20px;
      }
      #ds-agent-panel.mode-half {
        width: 45vw; height: 100vh;
        top: 0; right: 0; bottom: auto;
        border-radius: 0;
      }
      #ds-agent-panel.mode-full {
        width: 100vw; height: 100vh;
        top: 0; left: 0; right: auto; bottom: auto;
        border-radius: 0;
      }
      #ds-agent-panel.closed { display: none; }

      /* ===== Header ===== */
      #ds-agent-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 14px; background: var(--ds-bg-surface0); cursor: move;
        user-select: none; flex-shrink: 0; min-height: 38px;
      }
      #ds-agent-header span { font-weight: 600; font-size: 13px; }
      #ds-agent-header-actions { display: flex; gap: 3px; }
      #ds-agent-header-actions button {
        background: none; border: none; color: var(--ds-text-primary); cursor: pointer;
        padding: 3px 7px; border-radius: 4px; font-size: 14px;
        line-height: 1; transition: background 0.15s;
      }
      #ds-agent-header-actions button:hover { background: var(--ds-bg-surface1); }
      #ds-agent-stop { color: var(--ds-accent-red) !important; }

      /* ===== Body ===== */
      #ds-agent-body {
        flex: 1; overflow: hidden; display: flex; flex-direction: column;
        padding: 0; position: relative;
      }
      #ds-agent-panel.mode-compact #ds-agent-body {
        padding: 10px 12px; max-height: 440px;
        overflow-y: auto;
      }
      #ds-agent-panel.mode-half #ds-agent-body,
      #ds-agent-panel.mode-full #ds-agent-body {
        flex-direction: row;
      }

      /* ===== Chat Column (left side) ===== */
      #ds-agent-chat-column {
        display: flex; flex-direction: column;
        flex: 0 0 60%; max-width: 80%; min-width: 30%;
        overflow: hidden;
      }
      #ds-agent-panel.mode-compact #ds-agent-chat-column {
        flex: 1; max-width: 100%; min-width: 0;
      }

      /* ===== Resize Handle ===== */
      #ds-agent-resize-handle {
        display: none;
        width: 4px; flex-shrink: 0;
        background: var(--ds-bg-surface0);
        cursor: col-resize;
        transition: background 0.15s;
        position: relative;
      }
      #ds-agent-resize-handle:hover,
      #ds-agent-resize-handle.active {
        background: var(--ds-accent-blue);
      }
      #ds-agent-resize-handle::after {
        content: '';
        position: absolute; inset: 0 -4px;
      }
      #ds-agent-panel.mode-half #ds-agent-resize-handle,
      #ds-agent-panel.mode-full #ds-agent-resize-handle {
        display: block;
      }

      /* ===== Messages ===== */
      #ds-agent-messages {
        flex: 1; overflow-y: auto; padding: 8px 0 0 0;
        display: flex; flex-direction: column;
        position: relative;
        min-height: 0;
      }
      #ds-agent-panel.mode-compact #ds-agent-messages { display: none; }

      /* ===== Messages: shared ===== */
      .ds-msg {
        padding: 14px 20px;
        font-size: 13px; line-height: 1.7; word-break: break-word;
        animation: dsMsgIn 0.2s ease;
        border-left: 3px solid transparent;
        border-bottom: 1px solid var(--ds-border-subtle);
      }
      @keyframes dsMsgIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      .ds-msg .msg-label {
        font-weight: 600; font-size: 11px; margin-bottom: 6px;
        letter-spacing: 0.3px;
        display: flex; align-items: center; gap: 6px;
      }
      .ds-msg .msg-content { font-size: 13px; color: var(--ds-text-primary); }

      /* User message: blue left accent, flat log style */
      .ds-msg.user {
        align-self: stretch; max-width: 100%;
        background: transparent;
        border-left-color: var(--ds-accent-blue);
      }
      .ds-msg.user .msg-label { color: var(--ds-accent-blue); }

      /* AI response: purple left accent, flat log style */
      .ds-msg.ai {
        align-self: stretch; max-width: 100%;
        background: transparent;
        border-left-color: var(--ds-accent-mauve);
        white-space: pre-wrap;
      }
      .ds-msg.ai .msg-label { color: var(--ds-accent-mauve); }
      .ds-msg.ai.streaming {
        background: rgba(203, 166, 247, 0.04);
      }

      /* Thinking: collapsible, amber/gold accent */
      .ds-msg.thinking {
        align-self: stretch; max-width: 100%;
        background: transparent;
        border-left: 3px solid var(--ds-accent-yellow);
        font-size: 12px; padding: 0;
        transition: all 0.2s ease;
        border-bottom: none;
      }
      .ds-msg.thinking .thinking-header {
        display: flex; align-items: center; gap: 6px;
        padding: 10px 20px; cursor: pointer; user-select: none;
        color: var(--ds-accent-yellow); font-weight: 600; font-size: 12px;
        transition: background 0.15s;
      }
      .ds-msg.thinking .thinking-header:hover { background: rgba(249, 226, 175, 0.06); }
      .ds-msg.thinking .thinking-arrow {
        font-size: 10px; transition: transform 0.2s ease;
        display: inline-block;
      }
      .ds-msg.thinking.collapsed .thinking-arrow { transform: rotate(-90deg); }
      .ds-msg.thinking .thinking-body {
        padding: 0 20px 12px 20px; color: var(--ds-text-secondary);
        font-size: 12px; line-height: 1.6;
        white-space: pre-wrap; max-height: 300px; overflow-y: auto;
      }
      .ds-msg.thinking.collapsed .thinking-body { display: none; }

      /* Tool call: blue left border, monospace args */
      .ds-msg.tool-call {
        align-self: stretch; max-width: 100%;
        background: transparent;
        border-left: 3px solid var(--ds-accent-blue);
        font-size: 12px; padding: 10px 20px;
      }
      .ds-msg.tool-call .msg-label { color: var(--ds-accent-blue); }
      .ds-msg.tool-call .msg-content {
        font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
        font-size: 12px; color: var(--ds-text-code); white-space: pre-wrap;
        max-height: 200px; overflow-y: auto;
        background: rgba(137, 180, 250, 0.05);
        padding: 10px 14px; border-radius: 6px;
        margin-top: 4px;
      }

      /* Tool result success: green left border */
      .ds-msg.tool-result {
        align-self: stretch; max-width: 100%;
        background: transparent;
        border-left: 3px solid var(--ds-accent-green);
        font-size: 12px; padding: 10px 20px;
      }
      .ds-msg.tool-result .msg-label { color: var(--ds-accent-green); }
      .ds-msg.tool-result .msg-content {
        font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
        font-size: 12px; color: var(--ds-text-code); white-space: pre-wrap;
        max-height: 200px; overflow-y: auto;
        background: rgba(166, 227, 161, 0.05);
        padding: 10px 14px; border-radius: 6px;
        margin-top: 4px;
      }

      /* Tool error: red left border */
      .ds-msg.tool-error {
        align-self: stretch; max-width: 100%;
        background: transparent;
        border-left: 3px solid var(--ds-accent-red);
        font-size: 12px; padding: 10px 20px;
      }
      .ds-msg.tool-error .msg-label { color: var(--ds-accent-red); }
      .ds-msg.tool-error .msg-content {
        font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
        font-size: 12px; color: var(--ds-text-code); white-space: pre-wrap;
        max-height: 200px; overflow-y: auto;
        background: rgba(243, 139, 168, 0.05);
        padding: 10px 14px; border-radius: 6px;
        margin-top: 4px;
      }

      /* System message: centered, muted */
      .ds-msg.system {
        align-self: center; max-width: 70%; text-align: center;
        background: transparent; color: var(--ds-text-muted);
        font-size: 11px; padding: 8px 20px;
        border-left: none; border-bottom: none;
      }

      /* ===== Status (compact mode) ===== */
      .ds-agent-status-row {
        display: flex; justify-content: space-between; padding: 4px 0;
        border-bottom: 1px solid var(--ds-bg-surface0);
      }
      .ds-agent-status-row span:first-child { color: var(--ds-text-secondary); }
      #ds-agent-panel.mode-half #ds-agent-status,
      #ds-agent-panel.mode-full #ds-agent-status { display: none; }

      /* ===== Steps Log (compact mode) ===== */
      #ds-agent-steps { margin-top: 8px; }
      #ds-agent-panel.mode-half #ds-agent-steps,
      #ds-agent-panel.mode-full #ds-agent-steps { display: none; }
      .ds-agent-step {
        padding: 6px 8px; margin: 4px 0; border-radius: 6px;
        background: var(--ds-bg-surface0); font-size: 12px; line-height: 1.4;
      }
      .ds-agent-step.tool { border-left: 3px solid var(--ds-accent-blue); }
      .ds-agent-step.result { border-left: 3px solid var(--ds-accent-green); }
      .ds-agent-step.error { border-left: 3px solid var(--ds-accent-red); }
      .ds-agent-step.thinking { border-left: 3px solid var(--ds-accent-yellow); }
      .ds-agent-step .step-label { font-weight: 600; margin-bottom: 2px; }
      .ds-agent-step .step-content { color: var(--ds-text-secondary); word-break: break-all; }

      /* ===== Input Area ===== */
      #ds-agent-input-area {
        display: flex; align-items: flex-end; gap: 8px;
        padding: 10px 14px; background: var(--ds-bg-mantle); border-top: 1px solid var(--ds-bg-surface0);
        flex-shrink: 0;
      }
      #ds-agent-panel.mode-compact #ds-agent-input-area {
        display: none;
      }
      #ds-agent-input {
        flex: 1; resize: none; min-height: 36px; max-height: 120px;
        padding: 8px 12px; background: var(--ds-bg-surface0); color: var(--ds-text-primary);
        border: 1px solid var(--ds-bg-surface1); border-radius: 8px;
        font-family: inherit; font-size: 13px; line-height: 1.4;
        outline: none; transition: border-color 0.15s;
      }
      #ds-agent-input:focus { border-color: var(--ds-accent-blue); }
      #ds-agent-input::placeholder { color: var(--ds-text-muted); }
      #ds-agent-send {
        width: 36px; height: 36px; flex-shrink: 0;
        background: var(--ds-accent-blue); color: var(--ds-text-on-accent); border: none;
        border-radius: 50%; cursor: pointer; font-size: 16px;
        font-weight: 700; display: flex; align-items: center;
        justify-content: center; transition: background 0.15s;
      }
      #ds-agent-send:hover { background: var(--ds-accent-sky); }
      #ds-agent-send:disabled { opacity: 0.4; cursor: not-allowed; }

      /* ===== Custom Scrollbar (messages & context panes) ===== */
      #ds-agent-messages::-webkit-scrollbar,
      .ds-context-pane::-webkit-scrollbar,
      .preview-content::-webkit-scrollbar,
      .ds-msg.tool-call .msg-content::-webkit-scrollbar,
      .ds-msg.tool-result .msg-content::-webkit-scrollbar,
      .ds-msg.tool-error .msg-content::-webkit-scrollbar,
      .ds-msg.thinking .thinking-body::-webkit-scrollbar {
        width: 6px;
      }
      #ds-agent-messages::-webkit-scrollbar-track,
      .ds-context-pane::-webkit-scrollbar-track,
      .preview-content::-webkit-scrollbar-track,
      .ds-msg.tool-call .msg-content::-webkit-scrollbar-track,
      .ds-msg.tool-result .msg-content::-webkit-scrollbar-track,
      .ds-msg.tool-error .msg-content::-webkit-scrollbar-track,
      .ds-msg.thinking .thinking-body::-webkit-scrollbar-track {
        background: transparent;
      }
      #ds-agent-messages::-webkit-scrollbar-thumb,
      .ds-context-pane::-webkit-scrollbar-thumb,
      .preview-content::-webkit-scrollbar-thumb,
      .ds-msg.tool-call .msg-content::-webkit-scrollbar-thumb,
      .ds-msg.tool-result .msg-content::-webkit-scrollbar-thumb,
      .ds-msg.tool-error .msg-content::-webkit-scrollbar-thumb,
      .ds-msg.thinking .thinking-body::-webkit-scrollbar-thumb {
        background: var(--ds-bg-surface1);
        border-radius: 3px;
      }
      #ds-agent-messages::-webkit-scrollbar-thumb:hover,
      .ds-context-pane::-webkit-scrollbar-thumb:hover,
      .preview-content::-webkit-scrollbar-thumb:hover,
      .ds-msg.tool-call .msg-content::-webkit-scrollbar-thumb:hover,
      .ds-msg.tool-result .msg-content::-webkit-scrollbar-thumb:hover,
      .ds-msg.tool-error .msg-content::-webkit-scrollbar-thumb:hover,
      .ds-msg.thinking .thinking-body::-webkit-scrollbar-thumb:hover {
        background: var(--ds-bg-surface2);
      }

      /* ===== Scroll-to-bottom button ===== */
      #ds-agent-scroll-bottom {
        position: sticky; bottom: 12px; align-self: flex-end;
        margin-top: -40px; /* pull up so it doesn't add extra scroll space */
        width: 32px; height: 32px; border-radius: 50%;
        background: var(--ds-bg-surface1); color: var(--ds-text-primary); border: 1px solid var(--ds-bg-surface2);
        cursor: pointer; font-size: 16px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
        z-index: 10; transition: background 0.15s; box-shadow: var(--ds-shadow-scroll);
      }
      #ds-agent-scroll-bottom:hover { background: var(--ds-bg-surface2); }

      /* ===== Full mode: split layout ===== */
      #ds-agent-panel.mode-full #ds-agent-chat-column {
        flex: 0 0 60%; max-width: 80%; min-width: 30%;
      }

      /* ===== Context Panel (right side, half & full mode) ===== */
      #ds-agent-context-panel {
        display: none; flex: 1; flex-direction: column;
        background: var(--ds-bg-mantle); overflow: hidden; min-width: 0;
      }
      #ds-agent-panel.mode-half #ds-agent-context-panel,
      #ds-agent-panel.mode-full #ds-agent-context-panel {
        display: flex;
      }

      /* Context tabs */
      #ds-agent-context-tabs {
        display: flex; flex-shrink: 0;
        border-bottom: 1px solid var(--ds-bg-surface0); background: var(--ds-bg-base);
      }
      .ds-context-tab {
        flex: 1; padding: 8px 4px; background: none; border: none;
        color: var(--ds-text-muted); cursor: pointer; font-size: 12px;
        font-family: inherit; transition: all 0.15s;
        border-bottom: 2px solid transparent;
      }
      .ds-context-tab:hover { color: var(--ds-text-primary); background: var(--ds-bg-hover); }
      .ds-context-tab.active {
        color: var(--ds-accent-blue); border-bottom-color: var(--ds-accent-blue);
      }

      /* Context content */
      #ds-agent-context-content {
        flex: 1; overflow: hidden; position: relative;
      }
      .ds-context-pane {
        display: none; position: absolute; inset: 0;
        overflow-y: auto; padding: 10px 12px;
      }
      .ds-context-pane.active { display: block; }
      .context-empty {
        color: var(--ds-text-muted); font-size: 12px; text-align: center;
        padding: 40px 20px;
      }

      /* File tree */
      #ds-agent-file-tree { font-size: 12px; }
      .file-tree-item {
        padding: 3px 6px; cursor: pointer; border-radius: 4px;
        color: var(--ds-text-code); display: flex; align-items: center; gap: 6px;
        transition: background 0.1s; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis;
      }
      .file-tree-item:hover { background: var(--ds-bg-hover); }
      .file-tree-item.selected { background: var(--ds-bg-surface0); color: var(--ds-accent-blue); }
      .file-tree-item.directory { color: var(--ds-accent-blue); font-weight: 600; }
      .file-tree-item .file-icon { font-size: 13px; flex-shrink: 0; }
      .file-tree-children { padding-left: 14px; }

      /* File preview */
      #ds-agent-file-preview { font-size: 12px; }
      .preview-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; background: var(--ds-bg-hover); border-radius: 6px;
        margin-bottom: 8px; font-size: 11px; color: var(--ds-text-secondary);
      }
      .preview-header .preview-filename {
        font-weight: 600; color: var(--ds-accent-blue); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
      .preview-content {
        font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
        font-size: 11px; line-height: 1.5; color: var(--ds-text-primary);
        white-space: pre-wrap; word-break: break-all;
        background: var(--ds-bg-crust); padding: 10px; border-radius: 6px;
        max-height: calc(100vh - 160px); overflow-y: auto;
      }
      .preview-content .line-number {
        color: var(--ds-bg-surface1); user-select: none; margin-right: 8px;
        display: inline-block; width: 32px; text-align: right;
      }

      /* Stats panel */
      #ds-agent-stats-panel { font-size: 12px; }
      .stats-card {
        background: var(--ds-bg-stats-card); border-radius: 8px; padding: 12px 14px;
        margin-bottom: 10px;
      }
      .stats-card .stats-label {
        color: var(--ds-text-muted); font-size: 11px; margin-bottom: 6px;
      }
      .stats-card .stats-value {
        font-size: 20px; font-weight: 700; color: var(--ds-text-primary);
      }
      .stats-card .stats-sub {
        font-size: 11px; color: var(--ds-text-muted); margin-top: 2px;
      }
      .stats-progress {
        margin-top: 8px; height: 6px; background: var(--ds-bg-surface0);
        border-radius: 3px; overflow: hidden;
      }
      .stats-progress-fill {
        height: 100%; border-radius: 3px; transition: width 0.5s ease;
      }
      .stats-progress-fill.low { background: var(--ds-accent-green); }
      .stats-progress-fill.medium { background: var(--ds-accent-yellow); }
      .stats-progress-fill.high { background: var(--ds-accent-red); }
      .stats-row {
        display: flex; justify-content: space-between; padding: 4px 0;
        border-bottom: 1px solid var(--ds-bg-hover); font-size: 11px;
      }
      .stats-row:last-child { border-bottom: none; }
      .stats-row .stats-row-label { color: var(--ds-text-muted); }
      .stats-row .stats-row-value { color: var(--ds-text-primary); font-weight: 600; }

      /* ===== FAB ===== */
      #ds-agent-fab {
        position: fixed; top: 20px; right: 20px; z-index: 99998;
        width: 44px; height: 44px; border-radius: 50%;
        background: var(--ds-bg-surface0); color: var(--ds-text-primary); border: none; cursor: pointer;
        font-size: 20px; box-shadow: var(--ds-shadow-fab);
        display: none; transition: all 0.2s ease;
      }
      #ds-agent-fab:hover { background: var(--ds-bg-surface1); transform: scale(1.1); }
    `;
    document.head.appendChild(style);
  }

  // ─── Panel Events ────────────────────────────────────────────

  function setupPanelEvents() {
    // Header click to minimize in compact mode (toggle visibility)
    document.getElementById('ds-agent-header').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (panelMode === 'compact') {
        // Toggle body visibility in compact mode
        const body = document.getElementById('ds-agent-body');
        const inputArea = document.getElementById('ds-agent-input-area');
        if (body.style.display === 'none') {
          body.style.display = '';
          inputArea.style.display = '';
        } else {
          body.style.display = 'none';
          inputArea.style.display = 'none';
        }
      }
    });

    // Input textarea keyboard
    inputTextarea = document.getElementById('ds-agent-input');
    sendButton = document.getElementById('ds-agent-send');

    inputTextarea.addEventListener('compositionstart', () => { isComposing = true; });
    inputTextarea.addEventListener('compositionend', () => { isComposing = false; });

    inputTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        sendUserMessage();
      }
    });

    inputTextarea.addEventListener('input', () => {
      // Auto-resize
      inputTextarea.style.height = 'auto';
      inputTextarea.style.height = Math.min(inputTextarea.scrollHeight, 120) + 'px';
    });

    sendButton.addEventListener('click', () => sendUserMessage());
  }

  // ─── Theme Switching ───────────────────────────────────────

  function toggleTheme() {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme();
    // Persist to config
    window.dsAgent?.setConfig('theme', currentTheme).catch(() => {});
  }

  function applyTheme() {
    document.body.setAttribute('data-ds-agent-theme', currentTheme);
    const themeBtn = document.getElementById('ds-agent-theme-toggle');
    if (themeBtn) {
      themeBtn.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
      themeBtn.title = currentTheme === 'dark' ? '切换亮色主题' : '切换暗色主题';
    }
  }

  // ─── Panel Modes ─────────────────────────────────────────────

  function cyclePanelMode() {
    const modes = ['compact', 'half', 'full'];
    const idx = modes.indexOf(panelMode);
    panelMode = modes[(idx + 1) % modes.length];
    applyPanelMode();
  }

  function applyPanelMode() {
    if (!panel) return;

    panel.classList.remove('mode-compact', 'mode-half', 'mode-full');
    panel.classList.add('mode-' + panelMode);

    // Update mode button icon
    const modeBtn = document.getElementById('ds-agent-mode-toggle');
    if (modeBtn) {
      const icons = { compact: '⧉', half: '⧄', full: '⊡' };
      modeBtn.textContent = icons[panelMode] || '⧉';
    }

    // Scroll messages to bottom
    if (messagesContainer) {
      setTimeout(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }, 400); // after transition
    }

    console.log(PREFIX + ' Panel mode: ' + panelMode);
  }

  function showPanel() {
    if (panel) {
      panel.classList.remove('closed');
      panel.style.display = '';
    }
    if (fabButton) fabButton.style.display = 'none';
    panelVisible = true;
    applyPanelMode();
  }

  function hidePanel() {
    if (panel) {
      panel.classList.add('closed');
    }
    if (fabButton) fabButton.style.display = 'block';
    panelVisible = false;
  }

  // ─── Message Display ─────────────────────────────────────────

  function addMessage(type, content, label) {
    if (!messagesContainer) return;
    const el = document.createElement('div');
    el.className = 'ds-msg ' + type;

    if (label) {
      const labelEl = document.createElement('div');
      labelEl.className = 'msg-label';
      labelEl.textContent = label;
      el.appendChild(labelEl);
    }

    const contentEl = document.createElement('div');
    contentEl.className = 'msg-content';
    contentEl.textContent = content;
    el.appendChild(contentEl);

    messagesContainer.appendChild(el);
    scrollMessagesToBottom();
    return el;
  }

  function updateAiBubble(delta) {
    // Check if we need a new AI bubble: either no current one, or a thinking
    // bubble was inserted after the current AI bubble (meaning we switched
    // phases: response → thinking → response again).
    var needNew = !currentAiBubble;
    if (!needNew && currentAiBubble) {
      var sib = currentAiBubble.nextElementSibling;
      while (sib) {
        if (sib.classList.contains('thinking')) { needNew = true; break; }
        sib = sib.nextElementSibling;
      }
    }
    if (needNew) {
      // Finalize old AI bubble if it exists (keep it in DOM, just stop tracking)
      if (currentAiBubble) {
        currentAiBubble.classList.remove('streaming');
        totalOutputChars += currentAiContent.length;
        currentAiBubble = null;
        currentAiContent = '';
      }
      // Remove placeholder by ID (robust, no text-matching)
      const placeholder = document.getElementById('ds-agent-placeholder');
      if (placeholder) placeholder.remove();
      currentAiBubble = addMessage('ai', delta, 'DS Agent');
      currentAiBubble.classList.add('streaming');
      currentAiContent = delta;
    } else {
      currentAiContent += delta;
      const contentEl = currentAiBubble.querySelector('.msg-content');
      if (contentEl) contentEl.textContent += delta;
    }
    scrollMessagesToBottom();
  }

  function finalizeAiBubble() {
    if (currentAiBubble) {
      currentAiBubble.classList.remove('streaming');
      totalOutputChars += currentAiContent.length;
    }
    currentAiBubble = null;
    currentAiContent = '';
  }

  function finalizeThinkingBubble() {
    currentThinkingBubble = null;
    currentThinkingContent = '';
  }

  function addThinkingBubble(delta) {
    if (!messagesContainer) return;

    // Check if we need a new thinking bubble: either no current one, or an AI
    // bubble was inserted after the current thinking bubble (meaning we switched
    // phases: thinking → response → thinking again).
    var needNew = !currentThinkingBubble;
    if (!needNew && currentThinkingBubble) {
      var sib = currentThinkingBubble.nextElementSibling;
      while (sib) {
        if (sib.classList.contains('ai')) { needNew = true; break; }
        sib = sib.nextElementSibling;
      }
    }
    if (!needNew && currentThinkingBubble) {
      // Same thinking phase — append delta to existing thinking bubble
      currentThinkingContent += delta;
      const body = currentThinkingBubble.querySelector('.thinking-body');
      if (body) body.textContent += delta;
      scrollMessagesToBottom();
      return;
    }

    // Need a new thinking bubble — stop tracking the old one (it stays in DOM)
    if (currentThinkingBubble) {
      currentThinkingBubble = null;
      currentThinkingContent = '';
    }

    // Create new thinking bubble
    const el = document.createElement('div');
    el.className = 'ds-msg thinking';
    el.innerHTML = `
      <div class="thinking-header">
        <span class="thinking-arrow">▼</span>
        <span>💭 思考过程</span>
      </div>
      <div class="thinking-body"></div>
    `;

    const body = el.querySelector('.thinking-body');
    body.textContent = delta;

    // Toggle collapse on header click (arrow rotation handled by CSS)
    const header = el.querySelector('.thinking-header');
    header.addEventListener('click', () => {
      el.classList.toggle('collapsed');
    });

    messagesContainer.appendChild(el);
    scrollMessagesToBottom();
    currentThinkingBubble = el;
    currentThinkingContent = delta;
    return el;
  }

  function addToolStepInline(type, label, content) {
    if (!messagesContainer) return;
    const el = document.createElement('div');
    const clsMap = {
      tool: 'tool-call',
      'tool-result': 'tool-result',
      'tool-error': 'tool-error',
    };
    el.className = 'ds-msg ' + (clsMap[type] || 'tool-call');

    const labelEl = document.createElement('div');
    labelEl.className = 'msg-label';
    labelEl.textContent = label;
    el.appendChild(labelEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'msg-content';
    contentEl.textContent = typeof content === 'string' ? content.slice(0, 500) : '';
    el.appendChild(contentEl);

    messagesContainer.appendChild(el);
    scrollMessagesToBottom();
    return el;
  }

  function scrollMessagesToBottom() {
    if (!messagesContainer || userScrolledUp) return;
    requestAnimationFrame(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  }

  // ─── Status / Steps (compact mode) ───────────────────────────

  function updateStatus(elementId, text) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = text;
  }

  function addStep(type, label, content) {
    if (!stepsContainer) return;
    const step = document.createElement('div');
    step.className = `ds-agent-step ${type}`;
    step.innerHTML = `<div class="step-label">${label}</div><div class="step-content">${escapeHtml(content)}</div>`;
    stepsContainer.appendChild(step);
    stepsContainer.scrollTop = stepsContainer.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Input / Send Flow ───────────────────────────────────────

  async function sendUserMessage() {
    // Prevent sending while agent is running (would interfere with the agentic loop)
    if (agentRunning) {
      console.log(PREFIX + ' Agent is running, ignoring user message');
      addMessage('system', 'Agent 正在运行中，请等待完成或点击 ⏹ 停止后再发送消息');
      return;
    }

    const text = inputTextarea?.value?.trim();
    if (!text) return;

    // Show user message in panel
    addMessage('user', text, '你');
    totalInputChars += text.length;
    inputTextarea.value = '';
    inputTextarea.style.height = 'auto';

    // Finalize any previous AI + thinking bubbles
    finalizeAiBubble();
    finalizeThinkingBubble();
    lastStreamType = null;

    // Remove any leftover placeholder bubbles
    const oldPlaceholders = messagesContainer?.querySelectorAll('.ds-msg.ai.streaming');
    if (oldPlaceholders) {
      for (const ph of oldPlaceholders) ph.remove();
    }

    // Show loading placeholder with unique ID for robust cleanup
    const placeholder = addMessage('ai', '思考中...');
    if (placeholder) {
      placeholder.classList.add('streaming');
      placeholder.id = 'ds-agent-placeholder';
    }

    // Send via adapter — handles DOM injection and SSE streaming
    const adapter = window.__dsAgentAdapter;
    if (!adapter) {
      addMessage('tool-error', 'Adapter 未初始化');
      return;
    }

    try {
      const fullResponse = await adapter.sendMessage(text);
      // Response bubbles are updated in real-time by onThinking/onContent callbacks
      // Check for tool calls and start agent loop if needed
      const calls = checkForToolCalls(fullResponse || '');
      if (calls.length > 0) {
        console.log(PREFIX + ' Detected ' + calls.length + ' tool call(s) from user message');
        await runAgenticLoop(calls);
      }
    } catch (err) {
      console.error(PREFIX + ' sendUserMessage failed:', err);
      addMessage('tool-error', '发送失败: ' + (err.message || '未知错误'));
    }

    // Update connection status
    updateStatus('ds-agent-conn-status', '✅ 已就绪');
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
    hint += '\n\n## 读取大文件';
    hint += '\n- read_file 默认只读取文件的前 200 行';
    hint += '\n- 如果返回结果末尾有截断提示，说明文件还有更多行';
    hint += '\n- 使用 start_line 参数从指定行继续读取，例如 start_line=201 读取下一段';
    hint += '\n- 可以增大 line_count 参数一次读取更多行，但建议不超过 500 行';
    hint += '\n- 先用默认参数读取文件开头了解结构，再根据需要分段读取后续部分';
    hint += '\n\n当收到 <tool_result> 包裹的文本时，这是你之前调用的工具的执行结果。请基于结果继续回答用户的问题，或决定是否需要调用更多工具。';
    return hint;
  }

  function updateToolHint() {
    currentToolHint = buildToolHint();
    window.__dsAgentToolHint = currentToolHint;
    window.dsAgent?.updateToolHint(currentToolHint);
  }

  // ─── Tool Call Detection ───────────────────────────────────

  /**
   * Detect genuine tool calls in the AI response.
   *
   * Strategy: real tool calls are always the LAST thing in the response.
   * If there's any text after the last ```mcp:...``` block, the calls are
   * just examples in an explanation — ignore them.
   */
  function checkForToolCalls(content) {
    if (!content || !toolRegistry.length) return [];

    const re = new RegExp(TOOL_CALL_RE.source, 'g');
    const matches = [];
    let match;
    while ((match = re.exec(content)) !== null) {
      matches.push({
        name: match[1],
        rawArgs: match[2].trim(),
        endIndex: match.index + match[0].length,
      });
    }

    if (matches.length === 0) return [];

    // Check if there's meaningful text after the last tool call block.
    // If yes, these are just examples in an explanation — don't execute.
    const lastEnd = matches[matches.length - 1].endIndex;
    const afterLast = content.substring(lastEnd).trim();
    if (afterLast.length > 0) {
      console.log(`${PREFIX} Tool calls found but followed by text ("${afterLast.substring(0, 50)}..."), treating as examples`);
      return [];
    }

    // Genuine tool calls — parse args and dedup
    const calls = [];
    for (const m of matches) {
      let args = {};
      try { args = JSON.parse(m.rawArgs); }
      catch { args = { input: m.rawArgs }; }

      const key = m.name + ':' + JSON.stringify(args);
      if (executedCalls.has(key)) continue;
      executedCalls.add(key);
      calls.push({ name: m.name, args });
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

    // Re-read max steps from config (picks up changes made in control panel)
    try {
      const savedSteps = await window.dsAgent.getConfig('max_steps');
      if (savedSteps != null && typeof savedSteps === 'number' && savedSteps > 0) {
        maxAgentLoops = savedSteps;
      }
    } catch (err) { /* keep current value */ }

    // Finalize current AI + thinking bubbles so tool result responses get new bubbles
    finalizeAiBubble();
    finalizeThinkingBubble();
    lastStreamType = null;

    updateStatus('ds-agent-loop-status', '🔄 运行中');
    const stopBtn = document.getElementById('ds-agent-stop');
    if (stopBtn) stopBtn.style.display = '';

    try {
      let pendingCalls = [...toolCalls];

      while (pendingCalls.length > 0 && agentStepCount < maxAgentLoops) {
        if (agentAbortController.signal.aborted) {
          addStep('thinking', '⏹ 已停止', '用户手动停止了 Agent');
          addToolStepInline('thinking', '⏹ 已停止', '用户手动停止了 Agent');
          break;
        }

        // ── Execute all tool calls, collect results (don't send yet) ──
        var allResults = [];

        for (const call of pendingCalls) {
          if (agentAbortController.signal.aborted) break;

          agentStepCount++;

          // Show tool step in both compact (steps) and expanded (inline) modes
          const stepLabel = `🔧 步骤 ${agentStepCount}: ${call.name}`;
          const stepContent = JSON.stringify(call.args, null, 2).slice(0, 200);
          addStep('tool', stepLabel, stepContent);
          if (panelMode === 'half' || panelMode === 'full') {
            addToolStepInline('tool', stepLabel, stepContent);
          }

          try {
            const result = await window.dsAgent.callTool(call.name, call.args);
            const resultText = result.data?.content?.[0]?.text || '(无结果)';
            const isError = result.data?.isError || false;

            addStep(
              isError ? 'error' : 'result',
              isError ? '❌ 执行失败' : '✅ 执行成功',
              String(resultText).slice(0, 300)
            );

            if (panelMode === 'half' || panelMode === 'full') {
              addToolStepInline(
                isError ? 'tool-error' : 'tool-result',
                isError ? '❌ 执行失败' : '✅ 执行成功',
                String(resultText)
              );
            }

            // Collect result (send later as batch)
            allResults.push({ toolName: call.name, resultText: String(resultText), isError: isError });
          } catch (err) {
            addStep('error', '❌ 异常', err.message);
            if (panelMode === 'half' || panelMode === 'full') {
              addToolStepInline('tool-error', '❌ 异常', err.message);
            }
            allResults.push({ toolName: call.name, resultText: err.message, isError: true });
          }
        }

        if (agentAbortController.signal.aborted) break;

        // ── Build combined result message ──
        var combinedResult = '';
        for (var ri = 0; ri < allResults.length; ri++) {
          var r = allResults[ri];
          combinedResult += '<tool_result tool="' + r.toolName + '">\n';
          combinedResult += (r.isError ? 'Error: ' : '') + r.resultText + '\n';
          combinedResult += '</tool_result>\n\n';
        }

        // ── Send results and wait for AI response via adapter ──
        var finalResponse;
        try {
          finalResponse = await window.__dsAgentAdapter.sendMessage(combinedResult);
        } catch (err) {
          if (agentAbortController.signal.aborted) break;
          console.log(PREFIX + ' Adapter sendMessage failed: ' + err.message);
          addStep('thinking', '❌ 发送失败', err.message);
          if (panelMode === 'half' || panelMode === 'full') {
            addToolStepInline('thinking', '❌ 发送失败', err.message);
          }
          break;
        }

        if (agentAbortController.signal.aborted) break;

        // Finalize the AI bubble from this round so its content is tracked
        finalizeAiBubble();

        // Check the final AI response for new tool calls
        executedCalls.clear(); // Reset dedup for the new round
        pendingCalls = checkForToolCalls(finalResponse || '');

        if (pendingCalls.length === 0) {
          console.log(PREFIX + ' No more tool calls detected, agent loop complete');
          break;
        }

        console.log(PREFIX + ' Detected ' + pendingCalls.length + ' new tool call(s), continuing loop (step ' + agentStepCount + ')');
      }

      if (agentStepCount >= maxAgentLoops) {
        addStep('thinking', '⚠️ 达到上限', `已执行 ${maxAgentLoops} 步，自动停止`);
        if (panelMode === 'half' || panelMode === 'full') {
          addToolStepInline('thinking', '⚠️ 达到上限', `已执行 ${maxAgentLoops} 步，自动停止`);
        }
      }
    } finally {
      agentRunning = false;
      agentAbortController = null;
      updateStatus('ds-agent-loop-status', '空闲');
      updateStats();
      const stopBtn2 = document.getElementById('ds-agent-stop');
      if (stopBtn2) stopBtn2.style.display = 'none';
    }
  }

  function stopAgentLoop() {
    if (agentAbortController) {
      agentAbortController.abort();
      agentRunning = false;

      // Abort any pending adapter operation
      if (window.__dsAgentAdapter) {
        window.__dsAgentAdapter.abort();
      }

      updateStatus('ds-agent-loop-status', '⏹ 已停止');
      addStep('thinking', '⏹ 已停止', '用户手动停止了 Agent');
      if (panelMode === 'half' || panelMode === 'full') {
        addToolStepInline('thinking', '⏹ 已停止', '用户手动停止了 Agent');
      }
    }
  }

  async function newConversation() {
    // Stop any running agent loop first
    stopAgentLoop();

    // Clear panel UI
    if (messagesContainer) messagesContainer.innerHTML = '';
    if (stepsContainer) stepsContainer.innerHTML = '';
    currentAiBubble = null;
    currentAiContent = '';
    currentThinkingBubble = null;
    currentThinkingContent = '';
    lastStreamType = null;
    executedCalls.clear();
    agentStepCount = 0;

    // Clear context panel
    previewFilePath = '';
    previewContent = '';
    totalInputChars = 0;
    totalOutputChars = 0;
    userScrolledUp = false;
    if (scrollToBottomBtn) scrollToBottomBtn.style.display = 'none';
    const previewEl = document.getElementById('ds-agent-file-preview');
    if (previewEl) previewEl.innerHTML = '<div class="context-empty">点击左侧文件以预览内容</div>';
    updateStats();
    switchContextTab('files');

    // Click DeepSeek's "new chat" button in the sidebar (SPA navigation, no reload)
    let clicked = false;

    // Strategy 1: search ALL elements (no visibility filter) for "开启新会话" in text or attributes
    const keywords = ['开启新会话', '新对话', 'New Chat', 'New chat', 'new chat'];
    const allEls = document.querySelectorAll('*');
    const candidates = [];
    for (const el of allEls) {
      // Skip our own agent panel
      if (el.closest('#ds-agent-panel')) continue;
      const text = (el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '');
      const title = (el.getAttribute('title') || '');
      const combined = text + ' ' + aria + ' ' + title;
      for (const kw of keywords) {
        if (combined.includes(kw)) {
          candidates.push({
            el,
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().substring(0, 40),
            text: text.substring(0, 60),
            aria: aria.substring(0, 40),
            title: title.substring(0, 40),
            visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          });
          break;
        }
      }
    }
    console.log(PREFIX + ' newConversation candidates (' + candidates.length + '):',
      candidates.map(c => ({ tag: c.tag, cls: c.cls, text: c.text, aria: c.aria, title: c.title, visible: c.visible })));

    if (candidates.length > 0) {
      // Sort by text length ascending (most specific first)
      candidates.sort((a, b) => a.text.length - b.text.length);
      let target = candidates[0].el;

      // Walk up to find a clickable ancestor
      let clickable = target;
      while (clickable && clickable !== document.body) {
        const tag = clickable.tagName.toLowerCase();
        const role = clickable.getAttribute('role');
        if (tag === 'button' || tag === 'a' || role === 'button' ||
            clickable.onclick || getComputedStyle(clickable).cursor === 'pointer') {
          break;
        }
        clickable = clickable.parentElement;
      }
      if (clickable && clickable !== document.body) {
        clickable.click();
        clicked = true;
        console.log(PREFIX + ' New conversation clicked:', clickable.tagName, clickable.className);
      } else {
        target.click();
        clicked = true;
        console.log(PREFIX + ' New conversation clicked span directly');
      }
    }

    // Strategy 2: try common selectors
    if (!clicked) {
      const selectors = [
        '[data-testid="new_chat_button"]',
        '[class*="new-chat"]',
        '[class*="new_chat"]',
        '[class*="sidebar"] [class*="new"]',
        'nav button:first-of-type',
        '[role="navigation"] button:first-of-type',
        'aside button:first-of-type',
      ];
      for (const sel of selectors) {
        try {
          const btn = document.querySelector(sel);
          if (btn) {
            btn.click();
            clicked = true;
            console.log(PREFIX + ' New conversation via selector: ' + sel);
            break;
          }
        } catch (e) { /* selector not supported */ }
      }
    }

    // Strategy 3: find sidebar container, click its first button/clickable child
    if (!clicked) {
      const sidebarSelectors = [
        '[class*="sidebar"]', '[class*="side-bar"]', '[class*="Sidebar"]',
        'nav', '[role="navigation"]', 'aside',
        '[class*="left"]', '[class*="drawer"]',
      ];
      for (const ss of sidebarSelectors) {
        try {
          const sidebar = document.querySelector(ss);
          if (!sidebar || sidebar.closest('#ds-agent-panel')) continue;
          // Find first button, a, or [role="button"] inside
          const btn = sidebar.querySelector('button, a, [role="button"], [class*="new"]');
          if (btn) {
            btn.click();
            clicked = true;
            console.log(PREFIX + ' New conversation via sidebar first-child in', ss, ':', btn.tagName, btn.className);
            break;
          }
        } catch (e) { /* skip */ }
      }
    }

    if (!clicked) {
      console.warn(PREFIX + ' Could not find new-chat button');
      addMessage('tool-error', '未找到新建会话按钮，请手动点击侧边栏的"开启新会话"');
    }

    // After creating new conversation, ensure expert mode is selected
    if (clicked) {
      setTimeout(() => selectExpertMode(), 500);
    }
  }

  // ─── Expert Mode Selection ──────────────────────────────────

  function selectExpertMode() {
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.closest('#ds-agent-panel')) continue;
      const text = (el.textContent || '').trim();
      // Find the "专家模式" element (likely a button or span)
      if (text === '专家模式') {
        // Check if already selected (parent or self has active/selected class)
        let node = el;
        while (node && node !== document.body) {
          const cls = (node.className || '').toString();
          if (cls.includes('active') || cls.includes('selected') || cls.includes('current') ||
              node.getAttribute('aria-pressed') === 'true' || node.getAttribute('aria-selected') === 'true') {
            console.log(PREFIX + ' Expert mode already selected');
            // Still ensure web search is off
            disableWebSearch();
            return;
          }
          node = node.parentElement;
        }
        // Click to select expert mode
        el.click();
        console.log(PREFIX + ' Expert mode selected');
        // After switching to expert mode, turn off web search
        setTimeout(() => disableWebSearch(), 300);
        return;
      }
    }
    console.log(PREFIX + ' Expert mode button not found');
  }

  function disableWebSearch() {
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.closest('#ds-agent-panel')) continue;
      const text = (el.textContent || '').trim();
      if (text === '智能搜索') {
        // Walk up from the span to find the actual clickable toggle container
        let toggle = el;
        while (toggle && toggle !== document.body) {
          const tag = toggle.tagName.toLowerCase();
          const role = toggle.getAttribute('role');
          const cls = (toggle.className || '').toString();
          if (tag === 'button' || tag === 'label' ||
              role === 'button' || role === 'switch' || role === 'checkbox' ||
              cls.includes('toggle') || cls.includes('switch') ||
              getComputedStyle(toggle).cursor === 'pointer') {
            break;
          }
          toggle = toggle.parentElement;
        }
        const target = (toggle && toggle !== document.body) ? toggle : el;

        // Check if currently ON — scan target and all its ancestors
        let isOn = false;
        let node = target;
        while (node && node !== document.body) {
          const cls = (node.className || '').toString();
          const ariaPressed = node.getAttribute('aria-pressed');
          const ariaChecked = node.getAttribute('aria-checked');
          const dataState = node.getAttribute('data-state');
          if (cls.includes('active') || cls.includes('selected') || cls.includes('checked') ||
              cls.includes('--on') || cls.includes('--enabled') ||
              ariaPressed === 'true' || ariaChecked === 'true' ||
              dataState === 'on' || dataState === 'checked' || dataState === 'active') {
            isOn = true;
            break;
          }
          node = node.parentElement;
        }

        if (isOn) {
          target.click();
          console.log(PREFIX + ' Web search disabled via <' + target.tagName.toLowerCase() + '>', target.className);
        } else {
          console.log(PREFIX + ' Web search already off (target: <' + target.tagName.toLowerCase() + '>', target.className + ')');
        }
        return;
      }
    }
    console.log(PREFIX + ' Web search button not found');
  }

  // ─── Keyboard Shortcuts ────────────────────────────────────

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Shift+M: cycle panel mode
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        cyclePanelMode();
      }
      // Ctrl+Shift+A: show/hide panel
      if (e.ctrlKey && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        if (panelVisible) {
          hidePanel();
        } else {
          showPanel();
        }
      }
      // Ctrl+Shift+S: stop agent
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        stopAgentLoop();
      }
      // Ctrl+Shift+N: new conversation
      if (e.ctrlKey && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        newConversation();
      }
    });
  }

  // ─── Context Panel (Right Side) ────────────────────────────

  // Parse a line from list_directory output: "d dirname" or "f filename (size bytes)"
  function parseListLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    // Format: "d name" for directory, "f name (size bytes)" for file
    if (trimmed.startsWith('d ')) {
      return { name: trimmed.slice(2).trim(), isDir: true };
    }
    if (trimmed.startsWith('f ')) {
      // Extract name before " (size bytes)"
      const rest = trimmed.slice(2).trim();
      const parenIdx = rest.lastIndexOf(' (');
      const name = parenIdx > 0 ? rest.slice(0, parenIdx) : rest;
      return { name: name.trim(), isDir: false };
    }
    // "? name" for unknown entries
    if (trimmed.startsWith('? ')) {
      return { name: trimmed.slice(2).trim(), isDir: false };
    }
    return null;
  }

  async function loadFileTree(dirPath) {
    const treeEl = document.getElementById('ds-agent-file-tree');
    if (!treeEl) return;

    treeEl.innerHTML = '<div class="context-empty">加载中...</div>';

    try {
      const result = await window.dsAgent.callTool('list_directory', { path: dirPath || workspacePath });
      const resultText = result.data?.content?.[0]?.text || '';
      const lines = String(resultText).split('\n').filter(l => l.trim());

      if (lines.length === 0) {
        treeEl.innerHTML = '<div class="context-empty">空目录</div>';
        return;
      }

      // Build tree structure (list_directory outputs: "d name" or "f name (size)")
      const root = {};
      for (const line of lines) {
        const parsed = parseListLine(line);
        if (!parsed) continue;
        root[parsed.name] = { _isDir: parsed.isDir, _children: {} };
      }

      fileTreeData = root;
      treeEl.innerHTML = '';
      renderTreeNodes(root, treeEl, dirPath || workspacePath);
    } catch (err) {
      treeEl.innerHTML = '<div class="context-empty">加载失败: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function renderTreeNodes(node, parentEl, basePath) {
    const entries = Object.entries(node).filter(([k]) => !k.startsWith('_'));
    entries.sort((a, b) => {
      const aIsDir = a[1]._isDir;
      const bIsDir = b[1]._isDir;
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a[0].localeCompare(b[0]);
    });

    for (const [name, info] of entries) {
      const item = document.createElement('div');
      item.className = 'file-tree-item' + (info._isDir ? ' directory' : '');
      item.innerHTML = '<span class="file-icon">' + (info._isDir ? '📁' : '📄') + '</span>' + name;
      item.title = name;
      parentEl.appendChild(item);

      const itemPath = basePath + '/' + name;

      if (info._isDir) {
        // Directory: toggle children on click
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'file-tree-children';
        childrenContainer.style.display = 'none';
        parentEl.appendChild(childrenContainer);

        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (childrenContainer.style.display === 'none') {
            // Load children if not yet loaded
            if (childrenContainer.children.length === 0) {
              childrenContainer.innerHTML = '<div class="context-empty" style="padding:4px">加载中...</div>';
              try {
                const result = await window.dsAgent.callTool('list_directory', { path: itemPath });
                const resultText = result.data?.content?.[0]?.text || '';
                const childLines = String(resultText).split('\n').filter(l => l.trim());
                childrenContainer.innerHTML = '';
                if (childLines.length === 0) {
                  childrenContainer.innerHTML = '<div class="context-empty" style="padding:4px;font-size:11px">空目录</div>';
                } else {
                  const childRoot = {};
                  for (const line of childLines) {
                    const parsed = parseListLine(line);
                    if (!parsed) continue;
                    childRoot[parsed.name] = { _isDir: parsed.isDir, _children: {} };
                  }
                  renderTreeNodes(childRoot, childrenContainer, itemPath);
                }
              } catch (err) {
                childrenContainer.innerHTML = '<div class="context-empty" style="padding:4px;font-size:11px">加载失败</div>';
              }
            }
            childrenContainer.style.display = '';
            item.querySelector('.file-icon').textContent = '📂';
          } else {
            childrenContainer.style.display = 'none';
            item.querySelector('.file-icon').textContent = '📁';
          }
        });
      } else {
        // File: click to preview
        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          // Highlight selected
          parentEl.querySelectorAll('.file-tree-item.selected').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          await previewFile(itemPath);
        });
      }
    }
  }

  async function previewFile(filePath) {
    previewFilePath = filePath;
    const previewEl = document.getElementById('ds-agent-file-preview');
    if (!previewEl) return;

    previewEl.innerHTML = '<div class="context-empty">加载中...</div>';
    switchContextTab('preview');

    try {
      const result = await window.dsAgent.callTool('read_file', { path: filePath });
      const content = result.data?.content?.[0]?.text || '';
      previewContent = String(content);

      const lines = previewContent.split('\n');
      const numbered = lines.map((line, i) =>
        '<span class="line-number">' + String(i + 1).padStart(3) + '</span>' + escapeHtml(line)
      ).join('\n');

      const fileName = filePath.split('/').pop();
      previewEl.innerHTML = `
        <div class="preview-header">
          <span class="preview-filename">📄 ${escapeHtml(fileName)}</span>
          <span>${lines.length} 行</span>
        </div>
        <div class="preview-content">${numbered}</div>
      `;
    } catch (err) {
      previewEl.innerHTML = '<div class="context-empty">加载失败: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function updateStats() {
    const statsEl = document.getElementById('ds-agent-stats-panel');
    if (!statsEl) return;

    const CONTEXT_LIMIT = 1000000; // 1M tokens
    // Rough estimate: ~3 chars per token for mixed Chinese/English/code
    const estimatedTokens = Math.ceil((totalInputChars + totalOutputChars) / 3);
    const usagePercent = Math.min(100, Math.round((estimatedTokens / CONTEXT_LIMIT) * 100));
    const usedK = (estimatedTokens / 1000).toFixed(1);
    const limitK = (CONTEXT_LIMIT / 1000).toFixed(0);

    let level = 'low';
    if (usagePercent > 70) level = 'high';
    else if (usagePercent > 40) level = 'medium';

    const msgCount = messagesContainer ? messagesContainer.querySelectorAll('.ds-msg.user').length : 0;

    statsEl.innerHTML = `
      <div class="stats-card">
        <div class="stats-label">上下文用量</div>
        <div class="stats-value">${usedK}K / ${limitK}K</div>
        <div class="stats-sub">约 ${estimatedTokens.toLocaleString()} tokens</div>
        <div class="stats-progress">
          <div class="stats-progress-fill ${level}" style="width:${usagePercent}%"></div>
        </div>
        <div class="stats-sub" style="margin-top:4px">已使用 ${usagePercent}%</div>
      </div>
      <div class="stats-card">
        <div class="stats-row">
          <span class="stats-row-label">用户消息</span>
          <span class="stats-row-value">${msgCount} 条</span>
        </div>
        <div class="stats-row">
          <span class="stats-row-label">输入字符</span>
          <span class="stats-row-value">${totalInputChars.toLocaleString()}</span>
        </div>
        <div class="stats-row">
          <span class="stats-row-label">输出字符</span>
          <span class="stats-row-value">${totalOutputChars.toLocaleString()}</span>
        </div>
        <div class="stats-row">
          <span class="stats-row-label">工具调用</span>
          <span class="stats-row-value">${agentStepCount} 次</span>
        </div>
      </div>
    `;
  }

  function switchContextTab(tab) {
    contextTab = tab;
    const tabs = contextPanel?.querySelectorAll('.ds-context-tab');
    const panes = contextPanel?.querySelectorAll('.ds-context-pane');
    if (tabs) {
      tabs.forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
      });
    }
    if (panes) {
      panes.forEach(p => {
        p.classList.toggle('active', p.dataset.pane === tab);
      });
    }
    // Refresh stats when switching to stats tab
    if (tab === 'stats') updateStats();
  }

  // ─── Login Detection ────────────────────────────────────────

  function waitForLogin() {
    const dom = window.__dsAgentDOM;
    let attempts = 0;
    const maxAttempts = 60; // 60 * 1s = 60s timeout
    const checkInterval = 1000;

    console.log(PREFIX + ' Waiting for DeepSeek login...');

    const timer = setInterval(() => {
      attempts++;
      try {
        const input = dom?.findInputElement?.();
        if (input) {
          clearInterval(timer);
          console.log(PREFIX + ' Login detected after ' + attempts + 's, showing panel');
          showPanel();
          return;
        }
      } catch (e) { /* dom not ready yet */ }

      if (attempts >= maxAttempts) {
        clearInterval(timer);
        console.log(PREFIX + ' Login not detected within ' + maxAttempts + 's, panel stays hidden');
      }
    }, checkInterval);
  }

  // ─── Init ──────────────────────────────────────────────────

  async function init() {
    console.log(`${PREFIX} v${VERSION} initializing...`);

    // Create DeepSeek adapter — unified interface for all chat interactions
    const adapter = new DeepSeekAdapter();
    window.__dsAgentAdapter = adapter;

    // Register streaming callbacks on the adapter (replaces old onThinking/onStreamContent)
    adapter.onThinking(function (delta) {
      if (!messagesContainer) return;
      if (!currentAiBubble) {
        const placeholder = document.getElementById('ds-agent-placeholder');
        if (placeholder) placeholder.remove();
      }
      if (lastStreamType === 'response' && currentAiBubble) {
        finalizeAiBubble();
      }
      lastStreamType = 'thinking';
      addThinkingBubble(delta);
    });

    adapter.onContent(function (delta) {
      if (!messagesContainer) return;
      if (lastStreamType === 'thinking' && currentThinkingBubble) {
        finalizeThinkingBubble();
      }
      lastStreamType = 'response';
      updateAiBubble(delta);
    });

    console.log(`${PREFIX} Adapter created and callbacks registered`);

    if (document.readyState !== 'complete') {
      await new Promise(resolve => window.addEventListener('load', resolve));
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // 1. Create UI
    createPanel();

    // 1.5 Wait for DeepSeek login, then auto-show panel
    waitForLogin();

    // 2. Check tool handler connection
    try {
      const health = await window.dsAgent.health();
      updateStatus('ds-agent-conn-status', health.success ? '✅ 已就绪' : '❌ 未就绪');
    } catch {
      updateStatus('ds-agent-conn-status', '❌ 未就绪');
    }

    // 3. Load tool registry
    await refreshToolRegistry();

    // 3.5 Load theme from config
    try {
      const savedTheme = await window.dsAgent.getConfig('theme');
      if (savedTheme === 'light' || savedTheme === 'dark') {
        currentTheme = savedTheme;
        console.log(`${PREFIX} Theme set to ${currentTheme} from config`);
      }
    } catch (err) {
      console.log(`${PREFIX} Could not read theme config, using default ${currentTheme}`);
    }
    applyTheme();

    // 3.6 Load max steps from config
    try {
      const savedSteps = await window.dsAgent.getConfig('max_steps');
      if (savedSteps != null && typeof savedSteps === 'number' && savedSteps > 0) {
        maxAgentLoops = savedSteps;
        console.log(`${PREFIX} Max agent loops set to ${maxAgentLoops} from config`);
      }
    } catch (err) {
      console.log(`${PREFIX} Could not read max_steps config, using default ${maxAgentLoops}`);
    }

    // 4. Setup keyboard shortcuts
    setupKeyboardShortcuts();

    // 5. Load workspace and file tree
    try {
      workspacePath = await window.dsAgent.getWorkspace();
      if (workspacePath) {
        console.log(`${PREFIX} Workspace: ${workspacePath}`);
        loadFileTree(workspacePath);
      }
    } catch (err) {
      console.log(`${PREFIX} Could not get workspace:`, err.message);
    }

    // Show initial stats
    updateStats();

    console.log(`${PREFIX} Ready — ${toolRegistry.length} tools available, mode: ${panelMode}`);

    // Select expert mode on startup (delayed to let DeepSeek UI render)
    setTimeout(() => selectExpertMode(), 1000);
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
