'use strict';

/**
 * Terminal renderer: hosts xterm.js, pipes data to/from the pi pty in main,
 * and provides controls for showing the DeepSeek webview.
 */

(function () {
  const dsAgent = window.dsAgent;
  if (!dsAgent || !dsAgent.pty || !dsAgent.view) {
    console.error('[terminal] dsAgent bridge missing — preload mismatch');
    return;
  }

  // Apply platform class so CSS can adjust header padding around the
  // native window controls (macOS traffic lights vs Win/Linux overlay).
  if (dsAgent.platform) {
    document.body.classList.add('platform-' + dsAgent.platform);
  }

  // ── xterm bootstrap ─────────────────────────────────────────────
  const Terminal = window.Terminal;
  const FitAddon = window.FitAddon && window.FitAddon.FitAddon;
  if (!Terminal || !FitAddon) {
    console.error('[terminal] xterm libraries failed to load');
    return;
  }

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    theme: {
      background: '#0e0e0f',
      foreground: '#dcdcdc',
      cursor: '#dcdcdc',
      selectionBackground: '#264f78',
    },
    scrollback: 5000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));
  try { fit.fit(); } catch (_) {}

  // ── right-click context menu ───────────────────────────────────
  (function wireContextMenu() {
    if (!dsAgent.contextMenu) return;
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Inside xterm: use xterm's own selection (bypasses DOM)
      const inTerm = e.target.closest('#term');
      const sel = inTerm ? term.getSelection() : window.getSelection().toString();
      dsAgent.contextMenu.show(e.clientX, e.clientY, sel);
    });
    dsAgent.contextMenu.onAction((action) => {
      switch (action) {
        case 'copy': {
          const sel = term.getSelection() || window.getSelection().toString();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          break;
        }
        case 'paste':
          navigator.clipboard.readText()
            .then((text) => { if (text) dsAgent.pty.write(text); })
            .catch(() => {});
          break;
        case 'selectAll':
          term.selectAll();
          break;
      }
    });
  })();

  // ── workspace controls ─────────────────────────────────────────
  const btnWorkspace = document.getElementById('btn-workspace');
  const workspaceLabel = document.getElementById('workspace-label');
  function setWorkspaceLabel(cwd) {
    workspaceLabel.textContent = cwd || '~';
    btnWorkspace.title = '工作目录：' + (cwd || '') + '（点击切换，将重启 pi）';
  }
  if (dsAgent.workspace) {
    dsAgent.workspace.get().then(setWorkspaceLabel).catch(() => {});
    dsAgent.workspace.onChanged((cwd) => {
      setWorkspaceLabel(cwd);
      term.reset();
    });
    btnWorkspace.addEventListener('click', async () => {
      try {
        const r = await dsAgent.workspace.choose();
        if (r && r.changed) {
          setWorkspaceLabel(r.cwd);
        }
      } catch (_) {}
    });
  }

  // ── pi pty wiring ───────────────────────────────────────────────
  let started = false;

  function startPi() {
    if (started) return;
    started = true;
    dsAgent.pty.start().catch((err) => {
      term.write('\r\n\x1b[31m[pi 启动失败: ' + (err && err.message || err) + ']\x1b[0m\r\n');
    });
  }

  dsAgent.pty.onData((data) => term.write(data));
  dsAgent.pty.onExit((info) => {
    const code = info && info.exitCode != null ? info.exitCode : '?';
    const sig = info && info.signal ? ' signal=' + info.signal : '';
    term.write('\r\n\x1b[33m[pi exited code=' + code + sig + ']\x1b[0m\r\n');
    started = false;
  });

  term.onData((d) => dsAgent.pty.write(d));

  // ── resize ──────────────────────────────────────────────────────
  function pushResize() {
    try {
      fit.fit();
      const cols = term.cols, rows = term.rows;
      dsAgent.pty.resize(cols, rows);
    } catch (_) {}
  }
  window.addEventListener('resize', pushResize);
  const ro = new ResizeObserver(pushResize);
  ro.observe(document.getElementById('term-host'));

  // ── DeepSeek toggle ─────────────────────────────────────────────
  const btnDs = document.getElementById('btn-deepseek');
  let deepseekVisible = false;
  function applyDsButton() {
    btnDs.textContent = deepseekVisible ? '终端' : '网页';
  }
  applyDsButton();
  // Sync initial state from main (main may have shown the view before this
  // renderer was listening for the view:deepseek-visible event).
  if (dsAgent.view.isDeepseekVisible) {
    dsAgent.view.isDeepseekVisible().then((v) => {
      deepseekVisible = !!v;
      applyDsButton();
    }).catch(() => {});
  }
  btnDs.addEventListener('click', () => {
    if (deepseekVisible) dsAgent.view.hideDeepseek();
    else dsAgent.view.showDeepseek();
  });
  dsAgent.view.onDeepseekVisible((vis) => {
    deepseekVisible = !!vis;
    applyDsButton();
    // when DeepSeek covers us we lose focus; restore terminal focus on hide
    if (!vis) {
      setTimeout(() => { try { term.focus(); pushResize(); } catch (_) {} }, 50);
    }
  });

  // Ctrl+Shift+D global shortcut handled by main; also accept locally as fallback
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      btnDs.click();
    }
  });

  document.getElementById('btn-restart').addEventListener('click', () => {
    if (!confirm('重启 pi 进程？终端历史会清空。')) return;
    dsAgent.pty.restart().then(() => {
      term.reset();
    }).catch((err) => term.write('\r\n\x1b[31m[重启失败: ' + (err && err.message || err) + ']\x1b[0m\r\n'));
  });

  if (dsAgent.prompt && dsAgent.prompt.openEditor) {
    document.getElementById('btn-prompt').addEventListener('click', () => {
      dsAgent.prompt.openEditor();
    });
  }

  if (dsAgent.settings && dsAgent.settings.open) {
    document.getElementById('btn-settings').addEventListener('click', () => {
      dsAgent.settings.open();
    });
  }

  // ── Mode toggle (expert / quick) ──────────────────────────────────
  const btnMode = document.getElementById('btn-mode');
  let currentMode = 'expert';

  function applyModeButton(mode) {
    currentMode = mode;
    btnMode.textContent = mode === 'quick' ? '快速' : '专家';
    btnMode.className = 'mode-btn ' + mode + ' active';
    btnMode.title = '当前：' + (mode === 'quick' ? '快速模式' : '专家模式') + '（点击切换）';
  }

  if (dsAgent.mode) {
    dsAgent.mode.get().then((mode) => {
      if (mode) applyModeButton(mode);
    }).catch(() => {});
    dsAgent.mode.onChanged((mode) => applyModeButton(mode));
    btnMode.addEventListener('click', () => {
      const next = currentMode === 'expert' ? 'quick' : 'expert';
      applyModeButton(next);
      dsAgent.mode.set(next);
    });
  }

  // ── kick off ────────────────────────────────────────────────────
  startPi();
  setTimeout(() => { try { term.focus(); } catch (_) {} }, 100);
})();
