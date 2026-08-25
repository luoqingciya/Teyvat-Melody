// 迷你播放器窗口 preload：接收主窗口推送的播放状态，并把控制操作回传主进程。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mini", {
  onState: (cb) => {
    ipcRenderer.on("mini:state", (_e, s) => cb(s));
  },
  toggle: () => ipcRenderer.invoke("mini:controls", { op: "toggle" }),
  prev: () => ipcRenderer.invoke("mini:controls", { op: "prev" }),
  next: () => ipcRenderer.invoke("mini:controls", { op: "next" }),
  seek: (t) => ipcRenderer.invoke("mini:controls", { op: "seek", t: Number(t) }),
  close: () => ipcRenderer.invoke("mini:close"),
});
