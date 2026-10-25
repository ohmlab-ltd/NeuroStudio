const { contextBridge, ipcRenderer } = require("electron");

// A sandboxed preload cannot require launch.cjs, so its argument names repeat here.
const launchValue = (prefix) => {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
};
const launchPort = Number(launchValue("--neuro-wifi-port="));

contextBridge.exposeInMainWorld("neuro", {
  launch: {
    networkOnly: process.argv.includes("--neuro-network-only"),
    wifiHost: launchValue("--neuro-wifi-host="),
    wifiPort: Number.isInteger(launchPort) && launchPort > 0 ? launchPort : null,
  },

  // Device transport
  open: (options) => ipcRenderer.invoke("device:open", options),
  openTcp: (options) => ipcRenderer.invoke("device:open-tcp", options),
  switchTransport: (mode, options) => ipcRenderer.invoke("device:switch-transport", mode, options),
  close: () => ipcRenderer.invoke("device:close"),
  write: (bytes) => ipcRenderer.send("device:write", bytes),
  setAutoRecover: (on) => ipcRenderer.send("device:set-auto-recover", on),
  setLinkKey: (host, key) => ipcRenderer.send("device:set-link-key", host, key),
  listBoards: () => ipcRenderer.invoke("device:list-boards"),
  defaults: () => ipcRenderer.invoke("device:defaults"),

  /** Every transport event. Returns an unsubscribe function. */
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("device:event", handler);
    return () => ipcRenderer.removeListener("device:event", handler);
  },

  // Files
  saveSnapshot: (suggestedName, bytes) =>
    ipcRenderer.invoke("file:save-snapshot", suggestedName, bytes),
  saveLog: (suggestedName, text) => ipcRenderer.invoke("file:save-log", suggestedName, text),
  startRecording: (suggestedName) => ipcRenderer.invoke("recorder:start", suggestedName),
  stopRecording: () => ipcRenderer.invoke("recorder:stop"),

  // Windows
  newWindow: () => ipcRenderer.invoke("window:new"),

  // Bootloader tool
  bootloader: {
    listPorts: () => ipcRenderer.invoke("bootloader:list-ports"),
    pickFile: () => ipcRenderer.invoke("bootloader:pick-file"),
    flash: (request) => ipcRenderer.invoke("bootloader:flash", request),
    state: () => ipcRenderer.invoke("bootloader:state"),
    cancel: (force) => ipcRenderer.invoke("bootloader:cancel", force === true),
    /** Log lines and progress of this window's flash. Returns an unsubscribe. */
    onEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("bootloader:event", handler);
      return () => ipcRenderer.removeListener("bootloader:event", handler);
    },
  },
});
