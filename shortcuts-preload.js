const { contextBridge, ipcRenderer } = require("electron");

// 「ショートカットの管理」ウィンドウ用。一覧を読むだけで、保存データは変更できない。
contextBridge.exposeInMainWorld("shortcutsApi", {
  getData: () => ipcRenderer.invoke("shortcuts:getData"),
  setAlwaysOnTop: (val) => ipcRenderer.send("shortcuts:setAlwaysOnTop", !!val),
  close: () => ipcRenderer.send("shortcuts:close"),
});
