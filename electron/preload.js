// 主窗口 preload：向渲染进程提供 window.pywebview.api 兼容对象。
// 注意：必须显式枚举方法，不能用 Proxy —— contextBridge 隔离环境下 Proxy 的
// get 陷阱不生效，动态属性会全部 undefined（表现为按钮点击无反应）。
// 只暴露前端实际调用的方法，保持架构纯净。
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

// 主窗口控制 → IPC（TheHeader 的 win(action)）
const WIN_OPS = ["minimize", "toggleMaximize", "close", "show"];

// 其余方法 → Flask /api/rpc（与 app.py_api.Api 公开方法对应）
const RPC_METHODS = ["saveFont", "removeFont"];

// 把参数转成结构化克隆可安全传输的普通值：
// Electron IPC 用 structured clone，Vue reactive 代理对象无法克隆，须先 JSON 序列化。
const cloneSafe = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const api = {};

for (const op of WIN_OPS) {
  api[op] = () => invoke("win:op", { op });
}
// 手动窗口拖拽：不复用 -webkit-app-region: drag —— 它与界面各处的 backdrop-filter
// 在 Chromium 内冲突，会把整窗误判为拖拽区并吞掉真实点击。改由主进程按光标坐标移动窗口。
// 主进程 win:drag-start 期间会临时关闭 resizable/maximizable 防拉伸；窗口创建时亦已设 thickFrame:false 去掉系统 resize 热区。
api.windowDragStart = () => invoke("win:drag-start");
api.windowDragEnd = () => invoke("win:drag-end");
// 桌面歌词（PlayerControls / desktopLyricsBridge）
api.toggleDesktopLyrics = () => invoke("lyrics:toggle");
api.getLyricsState = () => invoke("lyrics:getState");
api.pushDesktopLyrics = (...args) => invoke("lyrics:push", { args: cloneSafe(args) });
// 监听歌词窗口可见性变化（歌词窗口 ✕ 关闭时同步主界面开关状态）
api.onLyricsVisibility = (cb) => {
  ipcRenderer.on("lyrics:visibility", (_e, v) => cb(v));
  return () => ipcRenderer.removeAllListeners("lyrics:visibility");
};
// 系统级全局快捷键（后台遥控播放）
api.applyGlobalHotkeys = (enabled) => invoke("hotkeys:apply", { enabled: !!enabled });
// 切歌桌面通知
api.notifySong = (payload) => invoke("notify:song", { ...payload });
// 全屏沉浸播放：切换原生全屏（屏蔽任务栏/最大化视口）
api.setFullscreen = (flag) => invoke("win:fullscreen", { flag: !!flag });
// 迷你模式：小窗置顶播放器
api.toggleMini = () => invoke("mini:toggle");
api.pushMiniState = (snapshot) => invoke("mini:push", { snapshot: cloneSafe(snapshot) });
// 监听迷你窗口可见性变化（迷你窗口 ✕ 关闭时同步主界面开关状态）
api.onMiniVisibility = (cb) => {
  ipcRenderer.on("mini:visibility", (_e, v) => cb(v));
  return () => ipcRenderer.removeAllListeners("mini:visibility");
};

for (const m of RPC_METHODS) {
  api[m] = (...args) => invoke("py:rpc", { method: m, args: cloneSafe(args) });
}

contextBridge.exposeInMainWorld("pywebview", { api });
