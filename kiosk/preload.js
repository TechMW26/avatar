const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kiosk", {
  scanWifi: () => ipcRenderer.invoke("wifi:scan"),
  connectWifi: (ssid, password) =>
    ipcRenderer.invoke("wifi:connect", ssid, password),
  checkInternet: () => ipcRenderer.invoke("wifi:check-internet"),
});
