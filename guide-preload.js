const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("guideApi", {
  setAlwaysOnTop: (val) => ipcRenderer.send("guide:setAlwaysOnTop", val),
  close: () => ipcRenderer.send("guide:close"),
});
