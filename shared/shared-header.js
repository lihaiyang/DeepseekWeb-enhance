/**
 * DS Enhance — Shared Infrastructure
 *
 * This file contains reusable UI components shared between ds-enhance and ds-mcp-bridge.
 * Since userscripts cannot import modules, this code is inlined into each script's header.
 *
 * Usage: Copy the sections you need into your userscript.
 * Each section is self-contained and marked with === SECTION NAME ===.
 */

// ═══════════════════════════════════════════════════════════════
//  SECTION: Utilities
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
//  SECTION: Toast
// ═══════════════════════════════════════════════════════════════
function toast(msg, type = 'info') {
  const colors = { info: '#2a2a3e', success: '#0d3320', error: '#3d0f0f' };
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:1000001;background:${colors[type]};color:#eee;padding:12px 22px;border-radius:10px;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.5);font-family:system-ui;transition:opacity .3s;`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
}

// ═══════════════════════════════════════════════════════════════
//  SECTION: CSS (core framework)
// ═══════════════════════════════════════════════════════════════
const SHARED_CSS = `
  #dse-fab{position:fixed;z-index:999999;width:48px;height:48px;border-radius:50%;background:#2563eb;color:#fff;border:none;font-size:22px;cursor:grab;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(37,99,235,.4);user-select:none;-webkit-user-select:none;touch-action:none}
  #dse-fab:active{cursor:grabbing}
  #dse-fab:hover{transform:scale(1.1);box-shadow:0 4px 20px rgba(37,99,235,.6)}

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
  .dse-actions button.pri{background:#2563eb;border-color:#2563eb;color:#fff}
  .dse-actions button.pri:hover{background:#3b82f6}
  .dse-actions button.dng{background:#7f1d1d;border-color:#991b1b}
  .dse-actions button.dng:hover{background:#991b1b}

  .dse-input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid #444;background:#1a1a28;color:#eee;font-size:13px;box-sizing:border-box;outline:none}
  .dse-input:focus{border-color:#7aa2f7}
  .dse-input::placeholder{color:#555}

  .dse-sel{padding:7px 10px;border:1px solid #444;border-radius:8px;background:#1a1a28;color:#eee;font-size:13px;outline:none}
  .dse-sel option{background:#1a1a28}

  .dse-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;transition:background .1s}
  .dse-row:hover{background:#1e1e2e}

  .dse-prog{font-size:13px;color:#aaa;padding:8px 0}
  .dse-prog .bar{height:4px;background:#333;border-radius:2px;margin-top:6px;overflow:hidden}
  .dse-prog .bar-i{height:100%;background:#2563eb;border-radius:2px;transition:width .2s}

  .dse-modal-bg{position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center}
  .dse-modal-box{background:#1a1a28;color:#eee;border-radius:14px;padding:0;min-width:380px;max-width:520px;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:system-ui;overflow:hidden}
  .dse-modal-box .mhd{padding:16px 20px;border-bottom:1px solid #2a2a3a;font-size:15px;font-weight:600}
  .dse-modal-box .mbd{padding:14px 20px;max-height:360px;overflow-y:auto}
  .dse-modal-box .mft{padding:12px 20px;border-top:1px solid #2a2a3a;display:flex;justify-content:flex-end;gap:8px}
  .dse-modal-box .mft button{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px}
  .dse-modal-box .mft .cancel{background:#333;color:#eee}.dse-modal-box .mft .cancel:hover{background:#444}
  .dse-modal-box .mft .confirm{background:#2563eb;color:#fff;font-weight:600}.dse-modal-box .mft .confirm:hover{background:#3b82f6}
`;

function injectSharedCSS(extraCSS = '') {
  const style = document.createElement('style');
  style.textContent = SHARED_CSS + extraCSS;
  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════
//  SECTION: FAB + Panel Framework
// ═══════════════════════════════════════════════════════════════
/**
 * Creates the floating action button and panel shell.
 * Returns { fab, panel, posPanel } for the caller to populate panel.innerHTML and wire up tabs.
 *
 * @param {object} opts
 * @param {string} opts.title - Panel title text
 * @param {string} opts.icon  - FAB icon (HTML entity or emoji)
 * @param {number} opts.width - Panel width in px (default 460)
 */
function createFABAndPanel(opts = {}) {
  const { title = 'DS 增强', icon = '&#9881;', width = 460 } = opts;

  // FAB
  const fab = document.createElement('button');
  fab.id = 'dse-fab';
  fab.innerHTML = icon;
  fab.title = title + ' (可拖动)';
  document.body.appendChild(fab);

  // Panel shell (content populated by caller)
  const panel = document.createElement('div');
  panel.id = 'dse-panel';
  panel.style.width = width + 'px';
  document.body.appendChild(panel);

  // Drag state
  let fabDragged = false, fabSX, fabSY, fabOX, fabOY;
  const DRAG_TH = 5;

  function posPanel() {
    const r = fab.getBoundingClientRect();
    let l = r.left;
    if (l + width > window.innerWidth - 10) l = window.innerWidth - width - 10;
    if (l < 10) l = 10;
    panel.style.left = l + 'px';
    panel.style.bottom = (window.innerHeight - r.top + 10) + 'px';
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

  // Initial position (bottom-left)
  fab.style.left = '20px';
  fab.style.top = (innerHeight - 68) + 'px';

  return { fab, panel, posPanel };
}

/**
 * Wires up tab switching for a panel.
 * Tab buttons must have data-tab attributes, sections must have id="sec-{tab}".
 */
function wireTabs(panel) {
  panel.querySelectorAll('#dse-tabs button').forEach(btn => {
    btn.onclick = () => {
      panel.querySelectorAll('#dse-tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      panel.querySelectorAll('.dse-section').forEach(s => s.classList.remove('active'));
      const sec = panel.querySelector(`#sec-${tab}`);
      if (sec) sec.classList.add('active');
      // Fire optional callback
      if (typeof onTabSwitch === 'function') onTabSwitch(tab);
    };
  });
}

/**
 * Creates a modal dialog.
 * @param {object} opts
 * @param {string} opts.title - Modal header text
 * @param {string} opts.bodyHTML - Body innerHTML
 * @param {string} opts.confirmText - Confirm button text (default "确认")
 * @param {function} opts.onConfirm - Called when confirm is clicked
 * @returns {HTMLElement} The modal overlay element
 */
function showModal(opts = {}) {
  const { title, bodyHTML = '', confirmText = '确认', onConfirm } = opts;
  const bg = document.createElement('div');
  bg.className = 'dse-modal-bg';
  bg.innerHTML = `<div class="dse-modal-box">
    <div class="mhd">${esc(title)}</div>
    <div class="mbd">${bodyHTML}</div>
    <div class="mft">
      <button class="cancel">取消</button>
      <button class="confirm">${esc(confirmText)}</button>
    </div>
  </div>`;
  bg.querySelector('.cancel').onclick = () => bg.remove();
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  bg.querySelector('.confirm').onclick = () => { bg.remove(); if (onConfirm) onConfirm(bg); };
  document.body.appendChild(bg);
  return bg;
}

/**
 * Creates a progress bar helper bound to a specific container element.
 * @param {HTMLElement} el - The .dse-prog container
 * @returns {{ show: function, hide: function }}
 */
function createProgressHelper(el) {
  return {
    show(text, pct) {
      el.style.display = 'block';
      el.innerHTML = `<div>${esc(text)}</div><div class="bar"><div class="bar-i" style="width:${pct}%"></div></div>`;
    },
    hide() { el.style.display = 'none'; }
  };
}
