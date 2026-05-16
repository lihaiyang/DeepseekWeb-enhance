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

  // ── status helpers ──────────────────────────────────────────────
  const dot = document.getElementById('dot');
  const statusText = document.getElementById('status-text');
  function setStatus(text, level) {
    statusText.textContent = text;
    dot.classList.remove('warn', 'err');
    if (level === 'warn') dot.classList.add('warn');
    if (level === 'err')  dot.classList.add('err');
  }

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
      setStatus('工作目录已切换：' + cwd);
    });
    btnWorkspace.addEventListener('click', async () => {
      try {
        const r = await dsAgent.workspace.choose();
        if (r && r.changed) {
          setWorkspaceLabel(r.cwd);
        }
      } catch (e) {
        setStatus('切换目录失败: ' + (e && e.message || e), 'err');
      }
    });
  }

  // ── pi pty wiring ───────────────────────────────────────────────
  let started = false;

  function startPi() {
    if (started) return;
    started = true;
    setStatus('正在启动 pi…');
    dsAgent.pty.start().then(() => {
      setStatus('pi 已启动');
    }).catch((err) => {
      setStatus('pi 启动失败: ' + (err && err.message || err), 'err');
    });
  }

  dsAgent.pty.onData((data) => term.write(data));
  dsAgent.pty.onExit((info) => {
    const code = info && info.exitCode != null ? info.exitCode : '?';
    const sig = info && info.signal ? ' signal=' + info.signal : '';
    setStatus('pi 已退出 (code=' + code + sig + ')', 'warn');
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
    btnDs.textContent = deepseekVisible ? '返回终端' : '显示 DeepSeek';
    btnDs.classList.toggle('active', deepseekVisible);
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
    setStatus('重启中…');
    dsAgent.pty.restart().then(() => {
      term.reset();
      setStatus('pi 已重启');
    }).catch((err) => setStatus('重启失败: ' + (err && err.message || err), 'err'));
  });

  // ── kick off ────────────────────────────────────────────────────
  startPi();
  setTimeout(() => { try { term.focus(); } catch (_) {} }, 100);
})();
