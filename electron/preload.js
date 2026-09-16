// 主窗口 preload：向渲染进程提供 window.pywebview.api 兼容对象。
// 注意：必须显式枚举方法，不能用 Proxy —— contextBridge 隔离环境下 Proxy 的
// get 陷阱不生效，动态属性会全部 undefined（表现为按钮点击无反应）。
// 只暴露前端实际调用的方法，保持架构纯净。
const { contextBridge, ipcRenderer } = require("electron");

// 把参数转成结构化克隆可安全传输的普通值：
// Electron IPC 用 structured clone，Vue 的 reactive 对象是 Proxy，**无法被克隆**
//（会抛 "An object could not be cloned."）。这里统一在 invoke 出口做 JSON 深拷贝，
// 而不是让每个方法各自记得处理 —— 漏一个就会在界面上表现为莫名的「操作失败」。
const cloneSafe = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** 统一的 IPC 出口：所有载荷都在此深拷贝，杜绝 reactive 对象漏进结构化克隆。 */
const invoke = (channel, payload) => ipcRenderer.invoke(channel, cloneSafe(payload));

// 主窗口控制 → IPC（TheHeader 的 win(action)）
const WIN_OPS = ["minimize", "toggleMaximize", "close", "show"];

// 其余方法 → Flask /api/rpc（与 app.py_api.Api 公开方法对应）
const RPC_METHODS = ["saveFont", "removeFont"];

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
api.pushDesktopLyrics = (...args) => invoke("lyrics:push", { args });
// 监听歌词窗口可见性变化（歌词窗口 ✕ 关闭时同步主界面开关状态）
api.onLyricsVisibility = (cb) => {
  ipcRenderer.on("lyrics:visibility", (_e, v) => cb(v));
  return () => ipcRenderer.removeAllListeners("lyrics:visibility");
};
// 系统级全局快捷键（后台遥控播放）
api.applyGlobalHotkeys = (enabled) => invoke("hotkeys:apply", { enabled: !!enabled });
// 快捷键（见 frontend/src/utils/shortcuts.js 的动作表）
// 全局快捷键必须交给主进程注册；主进程触发后只回传「哪个动作」，具体做什么由渲染进程查表执行。
api.setGlobalShortcuts = ({ enabled, shortcuts }) =>
  invoke("shortcuts:setGlobal", { enabled: enabled !== false, shortcuts: shortcuts || {} });
api.onShortcutAction = (cb) => {
  const h = (_e, id) => cb(id);
  ipcRenderer.on("shortcut:action", h);
  return () => ipcRenderer.removeListener("shortcut:action", h);
};
api.toggleMainWindow = () => invoke("win:op", { op: "toggle" });
api.quitApp = () => invoke("win:op", { op: "quit" });
// 桌面歌词：锁定（鼠标穿透）/ 置顶
api.toggleLyricsLock = () => invoke("lyrics:lock");
api.toggleLyricsTopmost = () => invoke("lyrics:topmost");
// 切歌桌面通知
api.notifySong = (payload) => invoke("notify:song", { ...payload });
// 全屏沉浸播放：切换原生全屏（屏蔽任务栏/最大化视口）
api.setFullscreen = (flag) => invoke("win:fullscreen", { flag: !!flag });
// 迷你模式：小窗置顶播放器
api.toggleMini = () => invoke("mini:toggle");
api.pushMiniState = (snapshot) => invoke("mini:push", { snapshot });
// 自定义源管理（洛雪源脚本）
api.listSources = () => invoke("source:list");
api.importSource = () => invoke("source:import");
api.removeSource = (id) => invoke("source:remove", { id });
api.toggleSource = (id, enabled) => invoke("source:toggle", { id, enabled: !!enabled });
api.reloadSource = (id) => invoke("source:reload", { id });
// 在线歌曲播放：取真实音频 URL（音质降级 + 换源重试在主进程完成）
// preferredQualities：设置页的「优先音质」多选，只影响尝试顺序，不作过滤
api.getOnlineUrl = (source, musicInfo, quality, preferredQualities) =>
  invoke("online:getUrl", { source, musicInfo, quality, preferredQualities });
// 在线搜索：可播放平台 + 关键词搜索（page 从 1 开始，翻页时递增）
api.getOnlinePlatforms = () => invoke("online:platforms");
api.searchOnline = (keyword, sources, page) => invoke("online:search", { keyword, sources, page: page || 1 });
// 在线歌曲歌词（翻译内联、逐字已展开，渲染进程零解析）
api.getOnlineLyric = (source, musicInfo) => invoke("online:lyric", { source, musicInfo });
// 检查更新：查 GitHub Release 最新版本（主进程比对版本号后回传结果）
api.getAppVersion = () => invoke("app:version");
// 数据目录（设置页展示 + 一键打开）：安装版在 %LOCALAPPDATA%，免安装版在软件目录
api.getDataDir = () => invoke("app:dataDir");
api.openDataDir = () => invoke("app:openDataDir");
api.checkUpdate = () => invoke("update:check");
// 下载更新包（主进程流式写入临时目录，进度经 update:progress 回传）
api.downloadUpdate = (url, name) => invoke("update:download", { url, name });
// 拉起安装包；reveal=true 时改为在资源管理器里定位（免安装版下载 zip 后自行解压）
api.installUpdate = (filePath, reveal) => invoke("update:install", { path: filePath, reveal: !!reveal });
api.onUpdateProgress = (cb) => {
  ipcRenderer.on("update:progress", (_e, p) => cb(p));
  return () => ipcRenderer.removeAllListeners("update:progress");
};
// 用系统浏览器打开更新页 / 下载链接（主进程会校验域名）
api.openUpdatePage = (url) => invoke("update:open", { url });
// HTTP 代理设置（配置存在 <数据根>/cache/config.json，主进程与后端共读）
api.getProxy = () => invoke("proxy:get");
api.setProxy = (cfg) => invoke("proxy:set", cfg || {});
api.testProxy = (cfg) => invoke("proxy:test", cfg || {});
// 任务栏进度：ratio 0~1 显示、-1 清除；paused 时进度条呈「暂停」外观
api.setTaskbarProgress = (ratio, paused) => invoke("taskbar:progress", { ratio, paused: !!paused });
// 播放时阻止系统休眠（只阻止系统挂起，不阻止屏幕熄灭）
api.setPreventSleep = (enabled) => invoke("power:preventSleep", { enabled: !!enabled });
// 监听迷你窗口可见性变化（迷你窗口 ✕ 关闭时同步主界面开关状态）
api.onMiniVisibility = (cb) => {
  ipcRenderer.on("mini:visibility", (_e, v) => cb(v));
  return () => ipcRenderer.removeAllListeners("mini:visibility");
};

for (const m of RPC_METHODS) {
  api[m] = (...args) => invoke("py:rpc", { method: m, args });
}

contextBridge.exposeInMainWorld("pywebview", { api });
