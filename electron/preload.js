const { contextBridge, ipcRenderer } = require("electron");

function createDisposableListener(channel, callback) {
  if (typeof callback !== "function") {
    return () => {};
  }
  const listener = (_event, payload) => {
    try {
      callback(payload);
    } catch (error) {
      console.error(`[meeting-buddy] Renderer listener for ${channel} failed`, error);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("meetingBuddy", {
  version: process.env.npm_package_version,
  environment: process.env.NODE_ENV ?? "production",
  saveAudio: (payload) => ipcRenderer.invoke("meetingBuddy:save-audio", payload),
  requestModel: () => ipcRenderer.invoke("meetingBuddy:get-model"),
  onModelChanged: (callback) => createDisposableListener("meetingBuddy:model-changed", callback),
  onReprocessRequested: (callback) => createDisposableListener("meetingBuddy:reprocess-active", callback)
});
