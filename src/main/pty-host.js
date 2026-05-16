'use strict';

/**
 * pty-host — runs inside a forked child process (Electron binary launched
 * with ELECTRON_RUN_AS_NODE=1). Lives only to load the native node-pty
 * binding against Node's ABI (the Electron main process has a different
 * ABI and the prebuilt .node files would fail to load there).
 *
 * Protocol over Node IPC (process.send / message):
 *   parent → child:  { type: 'spawn', bin, args, cwd, env, cols, rows }
 *                    { type: 'write', data }
 *                    { type: 'resize', cols, rows }
 *                    { type: 'kill', signal? }
 *   child  → parent: { type: 'ready' }
 *                    { type: 'spawned', pid }
 *                    { type: 'data', data }
 *                    { type: 'exit', exitCode, signal }
 *                    { type: 'error', message }
 */

// ── Windows ABI workaround ────────────────────────────────────────
// @homebridge/node-pty-prebuilt-multiarch's windowsPtyAgent.js hard-requires
// '../build/Release/conpty.node'. The prebuild tarball is published with
// that exact layout, so a clean `npm install` populates the directory and
// require works. If a downstream `electron-rebuild` (or similar) wipes
// build/Release/ during its clean phase and then fails to recompile, the
// require will silently break — surface a clear diagnostic so the user can
// recover quickly.
(function checkWindowsBuildRelease() {
  if (process.platform !== 'win32') return;
  const fs = require('fs');
  const path = require('path');
  let pkgRoot;
  try {
    pkgRoot = path.dirname(require.resolve('@homebridge/node-pty-prebuilt-multiarch/package.json'));
  } catch (_) { return; }
  const conpty = path.join(pkgRoot, 'build', 'Release', 'conpty.node');
  if (fs.existsSync(conpty)) return;
  process.stderr.write(
    '\n[pty-host] FATAL: build/Release/conpty.node is missing.\n' +
    '[pty-host] This typically happens after electron-rebuild wipes the\n' +
    '[pty-host] directory. Recover with:\n' +
    '[pty-host]   npm rebuild @homebridge/node-pty-prebuilt-multiarch\n' +
    '[pty-host] or (more forcefully):\n' +
    '[pty-host]   Remove-Item -Recurse -Force node_modules\\@homebridge\n' +
    '[pty-host]   npm install\n\n'
  );
  process.exit(2);
})();

const pty = require('@homebridge/node-pty-prebuilt-multiarch');

let proc = null;

function sendSafe(payload) {
  try { if (process.send) process.send(payload); } catch (_) { /* parent gone */ }
}

function killCurrent(signal) {
  if (!proc) return;
  const p = proc;
  proc = null;
  try { p.kill(signal); } catch (_) {}
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  try {
    switch (msg.type) {
      case 'spawn': {
        if (proc) killCurrent();
        const env = Object.assign({}, process.env, msg.env || {});
        proc = pty.spawn(msg.bin, msg.args || [], {
          name: msg.name || 'xterm-256color',
          cols: msg.cols || 100,
          rows: msg.rows || 30,
          cwd: msg.cwd || process.cwd(),
          env,
          useConpty: process.platform === 'win32',
        });
        proc.onData((data) => sendSafe({ type: 'data', data }));
        proc.onExit((info) => {
          sendSafe({ type: 'exit', exitCode: info && info.exitCode, signal: info && info.signal });
          proc = null;
        });
        sendSafe({ type: 'spawned', pid: proc.pid });
        break;
      }
      case 'write':
        if (proc && typeof msg.data === 'string') proc.write(msg.data);
        break;
      case 'resize':
        if (proc) {
          try { proc.resize(msg.cols || 100, msg.rows || 30); } catch (_) {}
        }
        break;
      case 'kill':
        killCurrent(msg.signal);
        break;
    }
  } catch (err) {
    sendSafe({ type: 'error', message: err && err.message || String(err) });
  }
});

process.on('disconnect', () => {
  killCurrent();
  setTimeout(() => process.exit(0), 50);
});

sendSafe({ type: 'ready' });
