/**
 * Preload for the terminal window. Exposes pty + view-toggle bridges; the
 * DeepSeek webview has its own (separate) preload.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsAgent', {
  pty: {
    start:   ()           => ipcRenderer.invoke('pty:start'),
    restart: ()           => ipcRenderer.invoke('pty:restart'),
    write:   (data)       => ipcRenderer.send('pty:write', data),
    resize:  (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
    onData:  (cb) => ipcRenderer.on('pty:data',  (_e, d) => cb(d)),
    onExit:  (cb) => ipcRenderer.on('pty:exit',  (_e, i) => cb(i)),
  },
  view: {
    showDeepseek:        () => ipcRenderer.send('view:show-deepseek'),
    hideDeepseek:        () => ipcRenderer.send('view:hide-deepseek'),
    isDeepseekVisible:   () => ipcRenderer.invoke('view:is-deepseek-visible'),
    onDeepseekVisible:   (cb) => ipcRenderer.on('view:deepseek-visible', (_e, v) => cb(v)),
  },
  workspace: {
    get:       () => ipcRenderer.invoke('workspace:get'),
    choose:    () => ipcRenderer.invoke('workspace:choose'),
    onChanged: (cb) => ipcRenderer.on('workspace:changed', (_e, cwd) => cb(cwd)),
  },
});
