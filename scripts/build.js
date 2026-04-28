#!/usr/bin/env node
/**
 * DS Agent — Build & Package Script
 *
 * One-click build script for packaging the Electron app.
 * Supports: macOS (DMG), Windows (NSIS), Linux (AppImage)
 *
 * Usage:
 *   node scripts/build.js          # Build for current platform
 *   node scripts/build.js --mac    # Build for macOS
 *   node scripts/build.js --win    # Build for Windows
 *   node scripts/build.js --linux  # Build for Linux
 *   node scripts/build.js --all    # Build for all platforms
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Configuration ─────────────────────────────────────────────
const PROJECT_DIR = path.join(__dirname, '..');
const ASSETS_DIR = path.join(PROJECT_DIR, 'assets');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf-8'));

const APP_NAME = PACKAGE_JSON.productName || PACKAGE_JSON.name;
const APP_VERSION = PACKAGE_JSON.version;

// Colors for terminal output
const Colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg, color = '') {
  console.log(`${color}${msg}${Colors.reset}`);
}

function logStep(step, msg) {
  log(`\n${Colors.cyan}${Colors.bold}[${step}]${Colors.reset} ${Colors.bold}${msg}${Colors.reset}`);
}

function logSuccess(msg) {
  log(`  ✅ ${msg}`, Colors.green);
}

function logWarn(msg) {
  log(`  ⚠️  ${msg}`, Colors.yellow);
}

function logError(msg) {
  log(`  ❌ ${msg}`, Colors.red);
}

function run(cmd, options = {}) {
  log(`  $ ${cmd}`, Colors.blue);
  try {
    execSync(cmd, {
      cwd: PROJECT_DIR,
      stdio: options.silent ? 'pipe' : 'inherit',
      env: { ...process.env, ...options.env },
    });
    return true;
  } catch (err) {
    if (!options.allowFail) {
      logError(`Command failed: ${cmd}`);
      process.exit(1);
    }
    return false;
  }
}

// ─── Parse Arguments ───────────────────────────────────────────
const args = process.argv.slice(2);
let buildMac = false;
let buildWin = false;
let buildLinux = false;

if (args.includes('--mac')) buildMac = true;
if (args.includes('--win')) buildWin = true;
if (args.includes('--linux')) buildLinux = true;
if (args.includes('--all')) {
  buildMac = true;
  buildWin = true;
  buildLinux = true;
}

// Default: build for current platform
if (!buildMac && !buildWin && !buildLinux) {
  const platform = os.platform();
  if (platform === 'darwin') buildMac = true;
  else if (platform === 'win32') buildWin = true;
  else buildLinux = true;
}

// ─── Print Banner ──────────────────────────────────────────────
log('');
log(`${Colors.bold}${Colors.blue}╔══════════════════════════════════════════╗${Colors.reset}`);
log(`${Colors.bold}${Colors.blue}║        DS Agent — Build System          ║${Colors.reset}`);
log(`${Colors.bold}${Colors.blue}╚══════════════════════════════════════════╝${Colors.reset}`);
log(`  App: ${Colors.bold}${APP_NAME}${Colors.reset} v${APP_VERSION}`);
log(`  Platform: ${os.platform()} ${os.arch()}`);
log(`  Targets: ${[
  buildMac && 'macOS',
  buildWin && 'Windows',
  buildLinux && 'Linux',
].filter(Boolean).join(', ')}`);
log('');

// ─── Step 1: Check Prerequisites ──────────────────────────────
logStep('1/5', 'Checking prerequisites');

// Check Node.js
const nodeVersion = process.version;
log(`  Node.js: ${nodeVersion}`);

// Check if npm dependencies are installed
if (!fs.existsSync(path.join(PROJECT_DIR, 'node_modules'))) {
  logWarn('node_modules not found, installing dependencies...');
  run('npm install');
} else {
  logSuccess('Dependencies installed');
}

// Check electron
const electronPath = path.join(PROJECT_DIR, 'node_modules', 'electron');
if (!fs.existsSync(electronPath)) {
  logError('Electron not found. Run: npm install');
  process.exit(1);
}
logSuccess('Electron found');

// Check electron-builder
const builderPath = path.join(PROJECT_DIR, 'node_modules', 'electron-builder');
if (!fs.existsSync(builderPath)) {
  logError('electron-builder not found. Run: npm install');
  process.exit(1);
}
logSuccess('electron-builder found');

// ─── Step 2: Generate Icons ───────────────────────────────────
logStep('2/5', 'Preparing app icons');

const requiredIcons = {
  png: path.join(ASSETS_DIR, 'icon.png'),
  ico: path.join(ASSETS_DIR, 'icon.ico'),
  icns: path.join(ASSETS_DIR, 'icon.icns'),
};

let needsIconGeneration = false;
for (const [type, iconPath] of Object.entries(requiredIcons)) {
  if (fs.existsSync(iconPath)) {
    const size = fs.statSync(iconPath).size;
    logSuccess(`icon.${type} exists (${(size / 1024).toFixed(1)} KB)`);
  } else {
    logWarn(`icon.${type} missing`);
    needsIconGeneration = true;
  }
}

if (needsIconGeneration) {
  log('  Generating icons...');

  // Try generating with Electron (render SVG in offscreen window)
  const iconGenScript = path.join(PROJECT_DIR, 'scripts', 'icon-gen.js');
  if (fs.existsSync(iconGenScript)) {
    // Run as Electron main process (not as Node)
    const isWin = os.platform() === 'win32';
    const envPrefix = isWin ? 'set ELECTRON_RUN_AS_NODE= &&' : 'ELECTRON_RUN_AS_NODE=';
    const genResult = run(`${envPrefix} npx electron "${iconGenScript}"`, { allowFail: true });
    if (genResult) {
      logSuccess('Icons generated successfully');
    }
  }

  // If icons still missing, try with sips on macOS
  if (!fs.existsSync(requiredIcons.png) && os.platform() === 'darwin') {
    const svgPath = path.join(ASSETS_DIR, 'icon.svg');
    if (fs.existsSync(svgPath)) {
      log('  Trying sips for PNG conversion...');
      // sips doesn't support SVG directly, so we need another approach
      // We'll use a simple HTML rendering approach
      logWarn('Please convert icon.svg to icon.png manually or use an online tool');
    }
  }

  // Final check
  if (!fs.existsSync(requiredIcons.png)) {
    logError('icon.png is required for building. Please provide it.');
    log('  Suggestion: Convert assets/icon.svg to PNG (512x512)');
    log('  Online: https://cloudconvert.com/svg-to-png');
    log('  macOS:  Use Preview.app or install librsvg (brew install librsvg, then rsvg-convert)');
    log('  Linux:  rsvg-convert -w 512 -h 512 assets/icon.svg -o assets/icon.png');
    process.exit(1);
  }
}

// electron-builder can generate ico/icns from png on respective platforms
if (!fs.existsSync(requiredIcons.ico)) {
  logWarn('icon.ico missing — electron-builder will generate it from icon.png on Windows build');
}
if (!fs.existsSync(requiredIcons.icns)) {
  logWarn('icon.icns missing — electron-builder will generate it from icon.png on macOS build');
}

// ─── Step 3: Clean Previous Build ─────────────────────────────
logStep('3/5', 'Cleaning previous build');

if (fs.existsSync(DIST_DIR)) {
  // Keep the dist directory but remove old artifacts
  const entries = fs.readdirSync(DIST_DIR);
  for (const entry of entries) {
    const entryPath = path.join(DIST_DIR, entry);
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch (err) {
      logWarn(`Could not remove ${entry}: ${err.message}`);
    }
  }
  logSuccess('Previous build artifacts removed');
} else {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  logSuccess('Created dist directory');
}

// ─── Step 4: Build ────────────────────────────────────────────
logStep('4/5', 'Building application');

const buildTargets = [];
if (buildMac) buildTargets.push('--mac');
if (buildWin) buildTargets.push('--win');
if (buildLinux) buildTargets.push('--linux');

const buildCmd = `npx electron-builder ${buildTargets.join(' ')}`;
log(`  Building: ${buildTargets.join(', ')}`);

const buildStart = Date.now();
run(buildCmd);
const buildTime = ((Date.now() - buildStart) / 1000).toFixed(1);
logSuccess(`Build completed in ${buildTime}s`);

// ─── Step 5: Summary ──────────────────────────────────────────
logStep('5/5', 'Build summary');

if (fs.existsSync(DIST_DIR)) {
  const entries = fs.readdirSync(DIST_DIR);
  const installers = entries.filter(e =>
    e.endsWith('.dmg') || e.endsWith('.exe') || e.endsWith('.AppImage') ||
    e.endsWith('.snap') || e.endsWith('.deb') || e.endsWith('.zip') ||
    e.endsWith('.tar.gz') || e.endsWith('.yml') || e.endsWith('.blockmap')
  );

  if (installers.length > 0) {
    log('');
    log(`${Colors.bold}📦 Generated installers:${Colors.reset}`);
    for (const f of installers) {
      const fpath = path.join(DIST_DIR, f);
      let size = 0;
      try { size = fs.statSync(fpath).size; } catch {}
      const sizeStr = size > 1048576
        ? `${(size / 1048576).toFixed(1)} MB`
        : size > 1024
          ? `${(size / 1024).toFixed(1)} KB`
          : `${size} B`;

      // Highlight actual installers
      const isInstaller = f.endsWith('.dmg') || f.endsWith('.exe') || f.endsWith('.AppImage');
      const prefix = isInstaller ? '  🎯' : '  📄';
      const color = isInstaller ? Colors.green : '';
      log(`${color}${prefix} ${f} (${sizeStr})${Colors.reset}`);
    }
  }
}

log('');
log(`${Colors.bold}${Colors.green}🎉 Build complete!${Colors.reset}`);
log(`  Output: ${DIST_DIR}`);
log('');
