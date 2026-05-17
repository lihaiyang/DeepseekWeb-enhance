'use strict';

/**
 * pi-runner — owns one pi CLI session per app run, hosted inside an
 * isolated pty-host child process so the native pty binding loads against
 * Node's ABI (not Electron's).
 */

const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');
const { fork } = require('child_process');

function resolvePiEntry() {
  const subPaths = [
    ['@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'],
    ['@earendil-works', 'pi-coding-agent', 'bin', 'pi'],
    ['@earendil-works', 'pi-coding-agent', 'bin', 'pi.js'],
  ];
  const roots = [
    path.join(app.getAppPath(), 'node_modules'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules'),
    path.join(process.resourcesPath || '', 'app', 'node_modules'),
  ];
  for (const root of roots) {
    for (const sub of subPaths) {
      const p = path.join(root, ...sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function ptyHostScriptPath() {
  // pty-host.js sits next to this file. Inside an asar archive, fork()
  // happily reads it because Node treats asar paths transparently for
  // module loading, but to be safe we resolve relative to __dirname.
  return path.join(__dirname, 'pty-host.js');
}

/**
 * Locate a real Node.js binary to spawn pi with.
 *
 * Why this matters: when pi is launched via Electron-as-Node
 * (process.execPath + ELECTRON_RUN_AS_NODE=1), even inside a real PTY pi's
 * `process.stdin.isTTY` reads as `false`. That makes pi take the
 * "non-interactive print" code path in main.js:42 and exit with code 0.
 * Spawning pi via a real Node binary avoids the Electron stdin wrapper
 * and isTTY behaves correctly.
 *
 * Resolution order:
 *   1. Bundled Node shipped alongside the app
 *      - packaged: <resourcesPath>/node/node[.exe]
 *      - dev:      <project>/vendor/node/<platform-key>/node[.exe]
 *   2. Real `node` found on PATH
 *   3. Last resort: Electron-as-Node (with a warning — pi may exit immediately)
 */
function bundledNodePath() {
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'node.exe' : 'node';
  // 1a. Packaged location — extraResources puts vendor/node/<key>/* under
  //     resources/node/.
  const resources = process.resourcesPath;
  if (resources) {
    const p = path.join(resources, 'node', exe);
    if (fs.existsSync(p)) return p;
  }
  // 1b. Dev mode — vendor/node/<platform-key>/node[.exe] populated by
  //     scripts/fetch-node.js.
  const platformKey =
    process.platform === 'win32'  ? 'win-' + process.arch :
    process.platform === 'darwin' ? 'darwin-' + process.arch :
    process.platform === 'linux'  ? 'linux-' + process.arch :
    null;
  if (platformKey) {
    const p = path.join(__dirname, '..', '..', 'vendor', 'node', platformKey, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveNodeBinary() {
  const isWin = process.platform === 'win32';
  // 1. Bundled Node (preferred — ships with the app, zero user setup)
  const bundled = bundledNodePath();
  if (bundled) return { bin: bundled, useElectronAsNode: false };
  // 2. Real Node on PATH.
  const envPaths = (process.env.PATH || '').split(isWin ? ';' : ':');
  const candidates = [];
  for (const dir of envPaths) {
    if (!dir) continue;
    candidates.push(path.join(dir, isWin ? 'node.exe' : 'node'));
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        return { bin: c, useElectronAsNode: false };
      }
    } catch (_) {}
  }
  // Shell-based which/where (handles PATHEXT etc. on Windows).
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(isWin ? 'where' : 'which', ['node'], {
      encoding: 'utf-8',
      shell: isWin,
    });
    if (r.status === 0 && r.stdout) {
      const line = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (line && fs.existsSync(line)) {
        return { bin: line, useElectronAsNode: false };
      }
    }
  } catch (_) {}
  // 3. Last resort: Electron-as-Node.
  console.warn('[pi-runner] no bundled Node and real Node not found on PATH; falling back to Electron-as-Node — pi may exit immediately due to isTTY=false');
  return { bin: process.execPath, useElectronAsNode: true };
}

class PiRunner {
  constructor(opts) {
    this._renderer = null;
    this._piHome = opts.piHome;
    this._extraEnv = opts.env || {};
    this._cwd = opts.cwd || null;
    this._host = null;
    this._cols = 100;
    this._rows = 30;
    this._wireIpc();
  }

  attachRenderer(webContents) { this._renderer = webContents; }
  setCwd(cwd) { this._cwd = cwd || null; }
  getCwd() { return this._cwd; }

  async restart() {
    await this._killCurrent();
    return this._spawn();
  }

  _wireIpc() {
    ipcMain.handle('pty:start', async () => {
      if (this._host) return { ok: true, alreadyRunning: true };
      return this._spawn();
    });
    ipcMain.handle('pty:restart', async () => {
      await this._killCurrent();
      return this._spawn();
    });
    ipcMain.on('pty:write', (_e, data) => {
      if (this._host && typeof data === 'string') {
        try { this._host.send({ type: 'write', data }); } catch (_) {}
      }
    });
    ipcMain.on('pty:resize', (_e, { cols, rows }) => {
      this._cols = cols || this._cols;
      this._rows = rows || this._rows;
      if (this._host) {
        try { this._host.send({ type: 'resize', cols: this._cols, rows: this._rows }); } catch (_) {}
      }
    });
  }

  _killCurrent() {
    return new Promise((resolve) => {
      if (!this._host) return resolve();
      const h = this._host;
      this._host = null;
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      h.once('exit', done);
      try { h.send({ type: 'kill' }); } catch (_) {}
      try { h.disconnect(); } catch (_) {}
      setTimeout(() => {
        try { h.kill('SIGKILL'); } catch (_) {}
        done();
      }, 1500);
    });
  }

  _spawn() {
    const entry = resolvePiEntry();
    if (!entry) {
      return Promise.reject(new Error('pi entry not found — run `npm install` or repackage with extraResources.'));
    }

    return new Promise((resolve, reject) => {
      const hostScript = ptyHostScriptPath();
      if (!fs.existsSync(hostScript)) {
        return reject(new Error('pty-host.js missing at ' + hostScript));
      }

      const { bin: nodeBin, useElectronAsNode } = resolveNodeBinary();

      // Build the env the pi *child* will see (passed through the host).
      const piEnv = Object.assign({}, process.env, this._extraEnv, {
        PI_CODING_AGENT_DIR: this._piHome,
        // PI_OFFLINE=1 skips pi's first-run downloads of fd / ripgrep. They
        // come from GitHub releases and are rate-limited / region-blocked
        // for many users (HTTP 403). pi falls back to a slower built-in
        // search when the binaries are absent.
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      });
      if (useElectronAsNode) {
        piEnv.ELECTRON_RUN_AS_NODE = '1';
      } else {
        // Strip ELECTRON_RUN_AS_NODE so pi (real Node) doesn't see a stale
        // flag inherited from the host's environment.
        delete piEnv.ELECTRON_RUN_AS_NODE;
      }
      delete piEnv.ELECTRON_NO_ATTACH_CONSOLE;

      // Fork the host using the Electron binary in Node mode. The forked
      // process inherits ELECTRON_RUN_AS_NODE=1 from execArgv so it
      // resolves modules using Node's ABI.
      let host;
      try {
        host = fork(hostScript, [], {
          execPath: process.execPath,
          env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
      } catch (err) {
        return reject(err);
      }

      this._host = host;

      let spawned = false;

      const onHostExit = (code, signal) => {
        if (this._host === host) this._host = null;
        if (!spawned) {
          reject(new Error('pty-host exited before pi spawn (code=' + code + ' signal=' + signal + ')'));
        } else if (this._renderer && !this._renderer.isDestroyed()) {
          this._renderer.send('pty:exit', { exitCode: code, signal });
        }
      };
      host.once('exit', onHostExit);

      host.stderr && host.stderr.on('data', (buf) => {
        const text = buf.toString('utf-8');
        if (!text.trim()) return;
        console.error('[pty-host stderr]', text.trim());
        // Surface to the terminal renderer so the user actually sees it.
        if (this._renderer && !this._renderer.isDestroyed()) {
          this._renderer.send('pty:data', '\r\n\x1b[31m[pty-host] ' + text.replace(/\n/g, '\r\n') + '\x1b[0m');
        }
      });

      host.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'ready':
            host.send({
              type: 'spawn',
              bin: nodeBin,
              args: [entry],
              cwd: this._cwd || piEnv.HOME || piEnv.USERPROFILE || process.cwd(),
              env: piEnv,
              cols: this._cols,
              rows: this._rows,
              name: 'xterm-256color',
            });
            break;
          case 'spawned':
            spawned = true;
            resolve({ ok: true, entry, pid: msg.pid });
            break;
          case 'data':
            if (this._renderer && !this._renderer.isDestroyed()) {
              this._renderer.send('pty:data', msg.data);
            }
            break;
          case 'exit':
            if (this._renderer && !this._renderer.isDestroyed()) {
              this._renderer.send('pty:exit', { exitCode: msg.exitCode, signal: msg.signal });
            }
            try { host.disconnect(); } catch (_) {}
            break;
          case 'error':
            if (!spawned) {
              reject(new Error('pty-host error: ' + msg.message));
            } else {
              console.error('[pty-host]', msg.message);
            }
            break;
        }
      });
    });
  }

  dispose() {
    return this._killCurrent();
  }
}

module.exports = { PiRunner };
