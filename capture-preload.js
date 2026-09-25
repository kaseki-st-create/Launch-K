const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("captureApi", {
  onInit: (callback) => ipcRenderer.on("capture:init", (event, data) => callback(data)),
  ready: () => ipcRenderer.send("capture:ready"),
  // rect: { x, y, w, h }（画面全体を0〜1とした割合）。キャンセル時は null
  done: (rect) => ipcRenderer.send("capture:done", rect),
});
