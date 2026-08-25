// 桌面歌词窗口 preload：接收歌词更新 + 拉取最近状态 + 通知双击 / 工具栏播放控制。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lyrics", {
  onUpdate: (cb) => {
    ipcRenderer.on("lyrics:update", (_e, payload) => cb(payload));
  },
  get: () => ipcRenderer.invoke("lyrics:get"),
  toggle: () => ipcRenderer.invoke("lyrics:toggle"),
  hide: () => ipcRenderer.invoke("lyrics:hide"),
  doubleClick: () => ipcRenderer.invoke("lyrics:doubleclick"),
  togglePlay: () => ipcRenderer.invoke("lyrics:togglePlay"),
  prev: () => ipcRenderer.invoke("lyrics:prev"),
  next: () => ipcRenderer.invoke("lyrics:next"),
  setFontSize: (delta) => ipcRenderer.invoke("lyrics:setFontSize", { delta }),
});
