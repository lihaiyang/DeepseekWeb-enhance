/**
 * Preload for the prompt-editor window. Exposes a narrow API for
 * reading / writing the user-customisable prompt template stored in
 * userData/app-config.json (via main).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsAgent', {
  platform: process.platform,
  prompt: {
    getCurrent:  () => ipcRenderer.invoke('prompt:get-current'),
    getDefault:  () => ipcRenderer.invoke('prompt:get-default'),
    isCustom:    () => ipcRenderer.invoke('prompt:is-custom'),
    set:         (t) => ipcRenderer.invoke('prompt:set', t),
    reset:       () => ipcRenderer.invoke('prompt:reset'),
  },
  window: {
    close: () => window.close(),
  },
});
