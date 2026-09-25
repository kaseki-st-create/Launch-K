const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("timerApi", {
  onStart: (callback) => ipcRenderer.on("timer:start", (event, seconds) => callback(seconds)),
  setAlwaysOnTop: (val) => ipcRenderer.send("timer:setAlwaysOnTop", val),
  suspendAlwaysOnTop: () => ipcRenderer.invoke("timer:suspendAlwaysOnTop"),
  close: () => ipcRenderer.send("timer:close"),
});
