#!/usr/bin/env node
'use strict';

/**
 * fetch-node — download a stand-alone Node.js binary for one or more
 * platform/arch combos and lay it out under vendor/node/<key>/node[.exe].
 *
 * Why: the packaged Electron app needs a real Node binary to spawn pi with.
 * Electron-as-Node makes pi's stdin.isTTY=false, which kicks pi into print
 * mode and exits immediately (see src/main/pi-runner.js:46).
 *
 * Layout produced:
 *   vendor/node/win-x64/node.exe
 *   vendor/node/darwin-x64/node
 *   vendor/node/darwin-arm64/node
 *   vendor/node/linux-x64/node
 *
 * Usage:
 *   node scripts/fetch-node.js                       # current platform
 *   node scripts/fetch-node.js --target win-x64      # specific
 *   node scripts/fetch-node.js --target win-x64 --target darwin-arm64
 *   node scripts/fetch-node.js --all                 # all four
 *
 * Re-running is cheap: existing binaries are kept untouched.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');

// ─── Configuration ───────────────────────────────────────────────────
const NODE_VERSION = process.env.NODE_FETCH_VERSION || 'v22.12.0';
const PROJECT_DIR = path.join(__dirname, '..');
const VENDOR_DIR = path.join(PROJECT_DIR, 'vendor', 'node');
const DIST_BASE = 'https://nodejs.org/dist/' + NODE_VERSION + '/';

const TARGETS = {
  'win-x64':      { archive: 'win-x64.zip',       binIn: 'node.exe',  binOut: 'node.exe' },
  'darwin-x64':   { archive: 'darwin-x64.tar.gz', binIn: 'bin/node',  binOut: 'node' },
  'darwin-arm64': { archive: 'darwin-arm64.tar.gz', binIn: 'bin/node', binOut: 'node' },
  'linux-x64':    { archive: 'linux-x64.tar.xz',  binIn: 'bin/node',  binOut: 'node' },
};

// ─── Logging ─────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
};
const log     = (m) => console.log(m);
const info    = (m) => console.log(C.cyan + '[fetch-node] ' + C.reset + m);
const okMsg   = (m) => console.log(C.green + '  ✓ ' + C.reset + m);
const warnMsg = (m) => console.log(C.yellow + '  ⚠ ' + C.reset + m);
const errMsg  = (m) => console.error(C.red + '  ✗ ' + C.reset + m);

// ─── Args ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const out = { targets: [], all: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') { out.targets.push(args[++i]); continue; }
    if (args[i].startsWith('--target=')) { out.targets.push(args[i].slice(9)); continue; }
    if (args[i] === '--all') { out.all = true; continue; }
    if (args[i] === '-h' || args[i] === '--help') {
      console.log('usage: node scripts/fetch-node.js [--target <key>]... [--all]');
      console.log('  --target: ' + Object.keys(TARGETS).join(', '));
      process.exit(0);
    }
  }
  return out;
}

function detectCurrentTarget() {
  const arch = process.arch;
  if (process.platform === 'win32')  return 'win-x64';        // we only ship x64 builds for now
  if (process.platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'linux')  return 'linux-x64';
  throw new Error('Unsupported platform: ' + process.platform);
}

// ─── Download (https.get with retry; falls back to curl/wget) ────────
function downloadHttps(url, destPath) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const max = 5;
    function get(u) {
      const req = https.get(u, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (++redirects > max) return reject(new Error('too many redirects'));
          res.resume();
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + u));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let seen = 0;
        let lastReported = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          seen += chunk.length;
          if (total && seen - lastReported >= total / 10) {
            const pct = ((seen / total) * 100).toFixed(0);
            process.stdout.write(C.dim + '    ' + pct + '%\r' + C.reset);
            lastReported = seen;
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => {
          process.stdout.write('              \r'); // clear progress line
          resolve();
        }));
        out.on('error', (err) => { try { fs.unlinkSync(destPath); } catch (_) {} reject(err); });
        res.on('error', (err) => { try { fs.unlinkSync(destPath); } catch (_) {} reject(err); });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    }
    get(url);
  });
}

function downloadViaCli(url, destPath) {
  // Prefer curl (predictable across Win10+/mac/linux); fall back to wget.
  // Both pick up HTTPS_PROXY / HTTP_PROXY from the environment when set.
  const curl = spawnSync('curl', ['-fSL', '--retry', '3', '--retry-delay', '2', '-o', destPath, url],
    { stdio: 'inherit' });
  if (curl.status === 0) return true;
  const wget = spawnSync('wget', ['-q', '--tries=3', '-O', destPath, url], { stdio: 'inherit' });
  if (wget.status === 0) return true;
  return false;
}

async function download(url, destPath) {
  const attempts = 3;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await downloadHttps(url, destPath);
      return;
    } catch (err) {
      lastErr = err;
      try { fs.unlinkSync(destPath); } catch (_) {}
      warnMsg('https attempt ' + i + '/' + attempts + ' failed: ' + (err.code || err.message));
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  warnMsg('https failed; trying curl/wget');
  if (downloadViaCli(url, destPath)) return;
  throw lastErr || new Error('download failed: ' + url);
}

// ─── Archive extraction (shells out — tar/Expand-Archive ship on all build OSes) ──
function extract(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const ext = archivePath.endsWith('.zip')
    ? 'zip'
    : archivePath.endsWith('.tar.gz')
      ? 'tar.gz'
      : archivePath.endsWith('.tar.xz')
        ? 'tar.xz'
        : 'unknown';
  if (ext === 'zip') {
    // tar -xf works for zip on Win10+ (bsdtar) and macOS; on Linux fall back to unzip.
    let r = spawnSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
    if (r.status === 0) return;
    r = spawnSync('unzip', ['-q', archivePath, '-d', destDir], { stdio: 'inherit' });
    if (r.status === 0) return;
    throw new Error('zip extract failed (tried tar and unzip)');
  }
  if (ext === 'tar.gz') {
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('tar -xzf failed for ' + archivePath);
    return;
  }
  if (ext === 'tar.xz') {
    const r = spawnSync('tar', ['-xJf', archivePath, '-C', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('tar -xJf failed for ' + archivePath + ' (need xz support)');
    return;
  }
  throw new Error('unknown archive type: ' + archivePath);
}

// ─── Per-target fetch ────────────────────────────────────────────────
async function fetchOne(key) {
  const spec = TARGETS[key];
  if (!spec) throw new Error('Unknown target: ' + key + ' (known: ' + Object.keys(TARGETS).join(', ') + ')');

  const outDir  = path.join(VENDOR_DIR, key);
  const outBin  = path.join(outDir, spec.binOut);
  if (fs.existsSync(outBin)) {
    okMsg(key + ': already present (' + path.relative(PROJECT_DIR, outBin) + ')');
    return;
  }

  const archiveName = 'node-' + NODE_VERSION + '-' + spec.archive;
  const url = DIST_BASE + archiveName;
  const cacheDir = path.join(VENDOR_DIR, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, archiveName);

  if (!fs.existsSync(archivePath)) {
    info('downloading ' + url);
    await download(url, archivePath);
  } else {
    okMsg(key + ': using cached archive ' + path.relative(PROJECT_DIR, archivePath));
  }

  // Extract into a temp sibling, then pluck just the node binary.
  const stageDir = path.join(cacheDir, '_stage-' + key);
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(stageDir, { recursive: true });
  info('extracting ' + archiveName);
  extract(archivePath, stageDir);

  // Archive contains a single top-level dir like "node-v22.12.0-darwin-arm64/".
  // Walk one level in to find spec.binIn.
  const entries = fs.readdirSync(stageDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());
  if (entries.length === 0) throw new Error('archive empty?');
  const topDir = path.join(stageDir, entries[0].name);
  const srcBin = path.join(topDir, spec.binIn);
  if (!fs.existsSync(srcBin)) throw new Error('node binary not found at ' + srcBin);

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(srcBin, outBin);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(outBin, 0o755); } catch (_) {}
  }
  okMsg(key + ': installed ' + path.relative(PROJECT_DIR, outBin));

  // Drop the stage dir but keep the cached archive (saves a re-download
  // next time someone needs to re-extract).
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
}

// ─── Main ────────────────────────────────────────────────────────────
(async () => {
  const opts = parseArgs();
  let targets = opts.all ? Object.keys(TARGETS) : opts.targets;
  if (targets.length === 0) {
    const cur = detectCurrentTarget();
    targets = [cur];
    info('no --target given; defaulting to current platform: ' + cur);
  }
  log('');
  info('Node version: ' + NODE_VERSION);
  info('Targets: ' + targets.join(', '));
  log('');
  let failed = 0;
  for (const t of targets) {
    try {
      await fetchOne(t);
    } catch (err) {
      errMsg(t + ': ' + (err && err.message || err));
      failed++;
    }
  }
  log('');
  if (failed > 0) {
    errMsg(failed + ' target(s) failed');
    process.exit(1);
  }
  info('done.');
})();
