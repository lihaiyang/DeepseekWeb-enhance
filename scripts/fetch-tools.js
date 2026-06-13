#!/usr/bin/env node
'use strict';

/**
 * fetch-tools — download stand-alone fd and ripgrep binaries for one or
 * more platform/arch combos and lay them out under vendor/tools/<key>/.
 *
 * Why: pi-coding-agent uses fd (fast file search) and ripgrep (fast grep)
 * for its find/grep tool implementations. By default pi downloads them
 * from GitHub Releases on first run, but GitHub is often rate-limited or
 * region-blocked for many users. Bundling them avoids these failures.
 *
 * Layout produced:
 *   vendor/tools/darwin-x64/fd   vendor/tools/darwin-x64/rg
 *   vendor/tools/darwin-arm64/fd vendor/tools/darwin-arm64/rg
 *   vendor/tools/win-x64/fd.exe  vendor/tools/win-x64/rg.exe
 *   vendor/tools/linux-x64/fd    vendor/tools/linux-x64/rg
 *
 * Usage:
 *   node scripts/fetch-tools.js                       # current platform
 *   node scripts/fetch-tools.js --target darwin-x64   # specific
 *   node scripts/fetch-tools.js --all                 # all platforms
 *
 * Re-running is cheap: existing binaries are kept untouched.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

// ─── Configuration ───────────────────────────────────────────────────
const FD_VERSION = process.env.FD_FETCH_VERSION || '10.2.0';
const RG_VERSION = process.env.RG_FETCH_VERSION || '14.1.1';
const PROJECT_DIR = path.join(__dirname, '..');
const VENDOR_DIR = path.join(PROJECT_DIR, 'vendor', 'tools');

// ─── Tool definitions ────────────────────────────────────────────────
const TOOLS = {
  fd: {
    name: 'fd',
    repo: 'https://github.com/sharkdp/fd/releases/download',
    version: FD_VERSION,
    tag: 'v' + FD_VERSION,
    platforms: {
      'darwin-x64':   { archive: `fd-v${FD_VERSION}-x86_64-apple-darwin.tar.gz`, binIn: 'fd' },
      'darwin-arm64': { archive: `fd-v${FD_VERSION}-aarch64-apple-darwin.tar.gz`, binIn: 'fd' },
      'win-x64':      { archive: `fd-v${FD_VERSION}-x86_64-pc-windows-msvc.zip`,  binIn: 'fd.exe' },
      'linux-x64':    { archive: `fd-v${FD_VERSION}-x86_64-unknown-linux-musl.tar.gz`, binIn: 'fd' },
    },
  },
  rg: {
    name: 'ripgrep',
    repo: 'https://github.com/BurntSushi/ripgrep/releases/download',
    version: RG_VERSION,
    tag: RG_VERSION,
    platforms: {
      'darwin-x64':   { archive: `ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`, binIn: 'rg' },
      'darwin-arm64': { archive: `ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`, binIn: 'rg' },
      'win-x64':      { archive: `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`,  binIn: 'rg.exe' },
      'linux-x64':    { archive: `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`, binIn: 'rg' },
    },
  },
};

const ALL_PLATFORMS = ['darwin-x64', 'darwin-arm64', 'win-x64', 'linux-x64'];

// ─── Logging ─────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
};
const info    = (m) => console.log(C.cyan + '[fetch-tools] ' + C.reset + m);
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
      console.log('usage: node scripts/fetch-tools.js [--target <key>]... [--all]');
      console.log('  --target: ' + ALL_PLATFORMS.join(', '));
      process.exit(0);
    }
  }
  return out;
}

function detectCurrentTarget() {
  const arch = process.arch;
  if (process.platform === 'win32')  return 'win-x64';
  if (process.platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'linux')  return 'linux-x64';
  throw new Error('Unsupported platform: ' + process.platform);
}

// ─── Download ────────────────────────────────────────────────────────
function downloadHttps(url, destPath) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const max = 5;
    function get(u) {
      const req = https.get(u, { timeout: 60000 }, (res) => {
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
          process.stdout.write('              \r');
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

// ─── Archive extraction ──────────────────────────────────────────────
function extract(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith('.zip')) {
    let r = spawnSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
    if (r.status === 0) return;
    r = spawnSync('unzip', ['-q', archivePath, '-d', destDir], { stdio: 'inherit' });
    if (r.status === 0) return;
    throw new Error('zip extract failed');
  }
  if (archivePath.endsWith('.tar.gz')) {
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('tar -xzf failed for ' + archivePath);
    return;
  }
  if (archivePath.endsWith('.tar.xz')) {
    const r = spawnSync('tar', ['-xJf', archivePath, '-C', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('tar -xJf failed for ' + archivePath);
    return;
  }
  throw new Error('unknown archive type: ' + archivePath);
}

// ─── Fetch one tool for one platform ─────────────────────────────────
async function fetchOneTool(toolKey, platKey) {
  const tool = TOOLS[toolKey];
  const plat = tool.platforms[platKey];
  if (!plat) throw new Error('Unknown platform ' + platKey + ' for ' + toolKey);

  const outDir = path.join(VENDOR_DIR, platKey);
  const outBin = path.join(outDir, plat.binIn);
  if (fs.existsSync(outBin)) {
    okMsg(toolKey + ' ' + platKey + ': already present (' + path.relative(PROJECT_DIR, outBin) + ')');
    return;
  }

  const cacheDir = path.join(VENDOR_DIR, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const archiveName = plat.archive;
  const archivePath = path.join(cacheDir, archiveName);
  const url = tool.repo + '/' + tool.tag + '/' + archiveName;

  if (!fs.existsSync(archivePath)) {
    info('downloading ' + toolKey + ' ' + platKey + ': ' + url);
    await download(url, archivePath);
  } else {
    okMsg(toolKey + ' ' + platKey + ': using cached archive');
  }

  // Extract into temp dir, then pluck the binary.
  const stageDir = path.join(cacheDir, '_stage-' + toolKey + '-' + platKey);
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(stageDir, { recursive: true });
  info('extracting ' + archiveName);
  extract(archivePath, stageDir);

  // The archive usually contains a single top-level dir — walk in to find the binary.
  function findBin(dir, name) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === name) return full;
      if (e.isDirectory()) {
        const found = findBin(full, name);
        if (found) return found;
      }
    }
    return null;
  }

  const srcBin = findBin(stageDir, plat.binIn);
  if (!srcBin) throw new Error('binary ' + plat.binIn + ' not found in archive');

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(srcBin, outBin);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(outBin, 0o755); } catch (_) {}
  }
  okMsg(toolKey + ' ' + platKey + ': installed ' + path.relative(PROJECT_DIR, outBin));

  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
}

// ─── Fetch all tools for a platform ──────────────────────────────────
async function fetchPlatform(platKey) {
  info('Fetching fd + rg for ' + platKey);
  await fetchOneTool('fd', platKey);
  await fetchOneTool('rg', platKey);
}

// ─── Main ────────────────────────────────────────────────────────────
(async () => {
  const opts = parseArgs();
  let targets = opts.all ? ALL_PLATFORMS : opts.targets;
  if (targets.length === 0) {
    const cur = detectCurrentTarget();
    targets = [cur];
    info('no --target given; defaulting to current platform: ' + cur);
  }
  console.log('');
  info('fd version: ' + FD_VERSION + '  |  rg version: ' + RG_VERSION);
  info('Targets: ' + targets.join(', '));
  console.log('');
  let failed = 0;
  for (const plat of targets) {
    if (!ALL_PLATFORMS.includes(plat)) {
      errMsg('Unknown target: ' + plat + ' (known: ' + ALL_PLATFORMS.join(', ') + ')');
      failed++;
      continue;
    }
    try {
      await fetchPlatform(plat);
    } catch (err) {
      errMsg(plat + ': ' + (err && err.message || err));
      failed++;
    }
  }
  console.log('');
  if (failed > 0) {
    errMsg(failed + ' target(s) failed');
    process.exit(1);
  }
  info('done.');
})();