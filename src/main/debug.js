// Debug script to test Electron main process
console.log('=== Electron Debug ===');
console.log('process.type:', process.type);
console.log('process.versions.electron:', process.versions.electron);
console.log('process.versions.node:', process.versions.node);

const e = require('electron');
console.log('require("electron") type:', typeof e);
console.log('require("electron") constructor:', e?.constructor?.name);

if (typeof e === 'string') {
  console.log('electron resolved to path:', e);
  console.log('This means we are NOT in the Electron main process!');
  console.log('process.execPath:', process.execPath);
  console.log('process.argv:', process.argv);
} else {
  console.log('electron keys:', Object.getOwnPropertyNames(e).slice(0, 30).join(', '));
  console.log('app:', typeof e.app);
}

process.exit(1);
