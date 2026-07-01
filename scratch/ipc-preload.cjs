// scratch/ipc-preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("api", {
  onChunks: (param) => {
    import_electron.ipcRenderer.on("chunk", (event, data) => {
      param(data);
    });
    import_electron.ipcRenderer.send("start");
  }
});
