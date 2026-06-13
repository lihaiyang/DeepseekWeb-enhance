/**
 * Preload for the settings window. Exposes a narrow API for reading and
 * updating app settings stored in userData/app-config.json (via main).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsAgent', {
  platform: process.platform,
  settings: {
    retry: {
      get:        () => ipcRenderer.invoke('settings:retry:get'),
      getDefault: () => ipcRenderer.invoke('settings:retry:get-default'),
      isCustom:   () => ipcRenderer.invoke('settings:retry:is-custom'),
      set:        (cfg) => ipcRenderer.invoke('settings:retry:set', cfg),
      reset:      () => ipcRenderer.invoke('settings:retry:reset'),
    },
  },
  window: {
    close: () => window.close(),
  },
});
