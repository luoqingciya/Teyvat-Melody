// Teyvat Melody - Electron 主进程
// 职责：spawn Python(Flask) 后端子进程、主窗口、系统托盘、单实例、
//       透明桌面歌词窗口、IPC 路由（窗口控制 / 歌词推送 / Flask RPC 代理）。
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, globalShortcut, Notification, nativeImage, dialog } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const { Transform, Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { SourceManager } = require("./sourceManager");
const onlineSearch = require("./onlineSearch");
const onlineLyric = require("./onlineLyric");
const updater = require("./updater");
const appConfig = require("./appConfig");
const proxyAgent = require("./proxyAgent");

const BACKEND_HOST = "127.0.0.1";
const DEFAULT_BACKEND_PORT = 5000;
// 端口在启动时动态选定（见 pickFreePort）——固定端口会让「同时开着两个实例」
// （便携版 + 安装版）互相串后端：后启动的抢不到端口，其窗口会连到先启动实例的后端，
// 数据于是被写进对方的数据目录，看起来就像数据错乱/丢失。
let backendPort = DEFAULT_BACKEND_PORT;
let BACKEND_URL = `http://${BACKEND_HOST}:${backendPort}`;
const IS_DEV = !app.isPackaged;
const dataRootUtil = require("./dataRoot");

// ---------------- 数据根目录 ----------------
// 选址规则见 electron/dataRoot.js（与后端 app/utils/paths.py 必须一致）。
// **数据一律放在软件目录（EXE 同级）**，整个目录自包含、可整体搬移。
// ⚠️ 安装版靠 resources/installer.nsh 的 customRemoveFiles 宏在升级时保住这些数据目录 ——
//    否则升级时旧版卸载程序会 `RMDir /r $INSTDIR` 把数据删光（真实发生过的缺陷）。
function installDir() {
  return dataRootUtil.installDir(process.execPath);
}

/** 是否为「安装版」（exe 同级有 Uninstall *.exe）。更新检查也用它判断分发方式。 */
function isInstalledBuild() {
  if (IS_DEV) return false;
  return dataRootUtil.isInstalledBuild(installDir());
}

/** 数据根目录（data / music / cache / sources / .appdata 都放它下面） */
function dataRoot() {
  return dataRootUtil.resolveDataRoot({
    isDev: IS_DEV,
    exePath: process.execPath,
    projectRoot: path.resolve(__dirname, ".."),
  });
}

/**
 * 把老位置里的数据搬到当前数据根目录（只在根目录还没有数据时执行）。
 *
 * 目前唯一的「老位置」是 v1.0.6 的 `%LOCALAPPDATA%\TeyvatMelody` ——
 * 那一版为了躲开卸载程序把安装版数据放在那里，本版又改回软件目录，
 * 所以升级上来时要搬回来，否则老用户会「看起来数据全没了」。
 *
 * 实现在 dataRoot.js（纯函数、有单测）；这里只做日志与调用。
 */
function migrateLegacyData(newRoot, legacyRoots) {
  const moved = dataRootUtil.migrateLegacyData(newRoot, legacyRoots);
  if (moved.length) {
    console.log(`[migrate] 已把老位置的数据搬到 ${newRoot}：${moved.join(", ")}`);
  }
  return moved;
}

// 把所有 Electron 端数据（桌面歌词设置、前端 localStorage 的配置/音量/播放进度/队列/歌词锁定等）
// 统一放到数据根目录下。必须在创建任何窗口之前调用 app.setPath 重定向 userData。
(function ensureUserDataUnderRoot() {
  const root = dataRoot();
  // 配置文件的读取一律基于数据根目录；这里注入一次即可（dataRoot 之后不会再变）
  appConfig.setDataRoot(root);
  // 先把 v1.0.6 留在 %LOCALAPPDATA% 的数据搬回软件目录（必须在 app.setPath 之前）
  if (!IS_DEV) {
    migrateLegacyData(root, [dataRootUtil.legacyLocalAppDataRoot(process.env.LOCALAPPDATA)]);
  }

  const prevUserData = app.getPath("userData");
  const newUserData = path.join(root, ".appdata");
  if (path.resolve(newUserData) === path.resolve(prevUserData)) return;
  app.setPath("userData", newUserData);
  // 首次运行时把旧 userData 里的既有数据（localStorage / 歌词设置）迁移到根目录，避免丢失历史配置
  if (!fs.existsSync(newUserData) && fs.existsSync(prevUserData)) {
    try {
      fs.mkdirSync(newUserData, { recursive: true });
      fs.cpSync(prevUserData, newUserData, { recursive: true });
    } catch (_) {}
  }
})();

let backendProc = null;
let mainWindow = null;
// 窗口姿态自管理模式（只用 setBounds，不用原生最大化/全屏/kiosk）。
// - 'windowed'   : 窗口化（启动时的居中大窗口；拖动后更新），是还原的唯一基准
// - 'maximized'  : 铺满工作区（任务栏仍可见）
// - 'fullscreen' : 沉浸播放（从最大化进入），铺满整块显示器（任务栏被遮挡）
let windowMode = "windowed";
let windowedBounds = null;   // 窗口化边界（启动居中大窗口；拖动后更新），作为还原的无污染基准
let fsPrevMode = "windowed"; // 进入沉浸全屏前的姿态（'windowed' | 'maximized'），退出时据此还原
let lyricsWindow = null;
let miniWindow = null;
let tray = null;
let lastLyrics = {}; // 最近一次歌词载荷（getDesktopLyrics 兜底）

// ---------------- 桌面歌词设置持久化（可见性 / 位置 / 尺寸） ----------------

function lyricSettingsPath() {
  return path.join(app.getPath("userData"), "lyrics-settings.json");
}
function loadLyricSettings() {
  try {
    return JSON.parse(fs.readFileSync(lyricSettingsPath(), "utf8"));
  } catch (_) {
    return {};
  }
}
function saveLyricSettings(patch) {
  const s = loadLyricSettings();
  Object.assign(s, patch);
  try {
    fs.writeFileSync(lyricSettingsPath(), JSON.stringify(s));
  } catch (_) {}
}

// 合并增量歌词载荷：顶层浅合并 + colors/appearance/options 嵌套深合并
function mergeLyrics(base, patch) {
  const out = { ...base, ...patch };
  if (patch.colors) out.colors = { ...(base.colors || {}), ...patch.colors };
  if (patch.appearance) out.appearance = { ...(base.appearance || {}), ...patch.appearance };
  if (patch.options) out.options = { ...(base.options || {}), ...patch.options };
  return out;
}

// 根据行数模式同步桌面歌词窗口高度（保持底部锚点）。
// 防抖：歌词推进 / 设置变化会高频调用，合并为一次。
// 注：窗口是 resizable:false，若不临时放开，setSize 不会生效（getSize 恒为原高），
// 导致"底部锚点平移"每次都被重复执行 → 拖动一次后窗口持续下移漂移。
let _syncTimer = null;
function syncLyricsSize() {
  if (!lyricsWindow) return;
  const opts = (lastLyrics && lastLyrics.options) || {};
  const mode = opts.lineMode || "dual";
  const target = mode === "multi" ? 196 : mode === "single" ? 112 : 150;

  const apply = () => {
    if (!lyricsWindow) return;
    const [w, h] = lyricsWindow.getSize();
    if (target === h) return; // 高度已匹配：绝不动窗口位置
    const [x, y] = lyricsWindow.getPosition();
    lyricsWindow.setResizable(true);
    lyricsWindow.setSize(w, target);
    lyricsWindow.setResizable(false);
    lyricsWindow.setPosition(x, y + (h - target)); // 底部边缘固定，仅行数切换时执行一次
    saveLyricSettings({ height: target });
  };

  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(apply, 60);
}

// ---------------- 后端子进程 ----------------

function backendCommand() {
  if (IS_DEV) {
    // 开发：用项目 venv 的 python 跑 electron_backend.py
    const root = path.join(__dirname, "..");
    const candidates = [
      path.join(root, ".venv", "Scripts", "python.exe"),
      path.join(root, "venv", "Scripts", "python.exe"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return { cmd: p, args: [path.join(root, "electron_backend.py")], cwd: root };
      }
    }
    throw new Error("未找到 .venv 的 python.exe，请先创建虚拟环境");
  }
  // 打包：运行随应用分发的后端 exe（electron-builder extraResources/backend）
  return locateBackendExe();
}

function findBackendExe(dir) {
  const direct = path.join(dir, "TeyvatBackend.exe");
  if (fs.existsSync(direct)) return { exe: direct, cwd: dir };
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    try {
      if (fs.statSync(full).isDirectory()) {
        const found = findBackendExe(full);
        if (found) return found;
      }
    } catch {
      // 忽略无法访问的目录
    }
  }
  return null;
}

function locateBackendExe() {
  const root = path.join(process.resourcesPath, "backend");
  const found = findBackendExe(root);
  if (found) return { cmd: found.exe, args: [], cwd: found.cwd };
  throw new Error("未找到后端程序 TeyvatBackend.exe，请检查 resources/backend 目录是否完整");
}

function startBackend() {
  const { cmd, args, cwd } = backendCommand();
  // 把选定的端口显式传给后端（缺省 5000 是给 `npm run dev:backend` 单独跑时用的）
  backendProc = spawn(cmd, [...args, `--port=${backendPort}`], { cwd, stdio: "ignore" });
  backendProc.on("exit", (code) => {
    console.log("[backend] exited:", code);
    backendProc = null;
  });
}

/** 让操作系统分配一个空闲端口（用于后端，避免多实例抢同一个端口） */
function pickFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => resolve(DEFAULT_BACKEND_PORT));
    srv.listen(0, BACKEND_HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 选定端口 → 记下 URL → 拉起后端（早于 app ready，与 Electron 初始化并行） */
const backendBoot = (async () => {
  backendPort = await pickFreePort();
  BACKEND_URL = `http://${BACKEND_HOST}:${backendPort}`;
  console.log("[backend] port:", backendPort);
  startBackend();
})();

function waitBackend(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const ping = () => {
      const req = http.get(BACKEND_URL + "/api/hello", (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(ping, 300);
      });
    };
    ping();
  });
}

// ---------------- 主窗口 ----------------

function createMainWindow() {
  // 默认窗口尺寸按主屏工作区自适应并居中，作为"窗口化/还原"的统一尺寸。
  // 原因：默认 1200x800 在最大化→全屏→退出→还原后，窗口会恢复到又小又偏左上的默认尺寸，
  // 与最大化的大尺寸形成"两种窗口化尺寸"。这里默认就放大并居中，让任一还原态都是大窗口且居中。
  const { screen } = require("electron");
  const wa = screen.getPrimaryDisplay().workArea;
  const defW = Math.max(1200, Math.min(Math.round(wa.width * 0.82), 1600));
  const defH = Math.max(800, Math.min(Math.round(wa.height * 0.85), 1000));
  const defX = wa.x + Math.round((wa.width - defW) / 2);
  const defY = wa.y + Math.round((wa.height - defH) / 2);
  mainWindow = new BrowserWindow({
    width: defW,
    height: defH,
    x: defX,
    y: defY,
    minWidth: 960,
    minHeight: 640,
    frame: false, // 无边框：前端 TheHeader 自制标题栏（手动 IPC 拖拽，非 -webkit-app-region）
    thickFrame: false, // 去掉 Windows WS_THICKFRAME：frameless 窗口四周无系统隐形 resize 热区，长按标题栏拖动不会被拉伸
    backgroundColor: "#0A0E1A",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 记录启动时真实窗口边界（含 DWM 边框微调），作为窗口化还原的唯一基准
  windowedBounds = mainWindow.getBounds();
  // 先加载本地加载页，窗口立即可见；后端就绪后再跳转 SPA（见 whenReady）
  mainWindow.loadFile(path.join(__dirname, "loading.html"));
  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // 关闭 → 最小化到托盘（真正退出走托盘菜单）
  mainWindow.on("close", (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------- 桌面歌词窗口（透明 / 无边框 / 置顶） ----------------

function createLyricsWindow() {
  lyricsWindow = new BrowserWindow({
    width: 720,
    height: 150, // 双行横排桌面歌词卡片（工具栏常驻 + 当前行 + 下一句/翻译行）
    frame: false,
    transparent: true, // 真正透明（Electron 成熟支持）
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "lyrics-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lyricsWindow.loadFile(path.join(__dirname, "lyrics.html"));
  lyricsWindow.on("closed", () => {
    lyricsWindow = null;
  });
  // 记忆窗口位置 / 尺寸（反复调整后无需每次都从下方居中）
  lyricsWindow.on("moved", () => {
    const [x, y] = lyricsWindow.getPosition();
    saveLyricSettings({ x, y });
  });
  lyricsWindow.on("resized", () => {
    const [w, h] = lyricsWindow.getSize();
    saveLyricSettings({ width: w, height: h });
  });
  // 默认屏幕下方居中（QQ 风格），若已保存位置则优先恢复
  const saved = loadLyricSettings();
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    lyricsWindow.setPosition(saved.x, saved.y);
  } else {
    const { screen } = require("electron");
    const wa = screen.getPrimaryDisplay().workArea;
    const [bw, bh] = lyricsWindow.getSize();
    lyricsWindow.setPosition(
      wa.x + Math.round((wa.width - bw) / 2),
      wa.y + wa.height - bh - 40
    );
  }
  lyricsWindow.hide();
}

// ---------------- 迷你播放器窗口（小窗 / 置顶 / 无边框） ----------------

// 是否允许创建迷你窗口的前端调用（防止窗口未建时被误触发）
function miniReady() {
  return !!miniWindow;
}

function createMiniWindow() {
  if (miniWindow) return;
  miniWindow = new BrowserWindow({
    width: 360,
    height: 140,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#0A0E1A",
    webPreferences: {
      preload: path.join(__dirname, "mini-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  miniWindow.loadFile(path.join(__dirname, "mini.html"));
  miniWindow.on("closed", () => {
    miniWindow = null;
    // 同步主界面「迷你模式」开关状态
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("mini:visibility", false);
    }
  });
  miniWindow.hide();
}

// 推送给迷你窗口的播放状态快照（前端构造后经 IPC 转发）
function miniPushState(snapshot) {
  if (!miniWindow || !miniWindow.isVisible()) return { ok: false };
  miniWindow.webContents.send("mini:state", snapshot);
  return { ok: true };
}

// 迷你窗口控制 → 转发到主窗口渲染进程执行播放控制
function miniControl(op, value) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  let script = "";
  if (op === "toggle") script = "window.__togglePlay && window.__togglePlay()";
  else if (op === "prev") script = "window.__prev && window.__prev()";
  else if (op === "next") script = "window.__next && window.__next()";
  else if (op === "seek" && Number.isFinite(Number(value))) {
    script = `window.__seek && window.__seek(${Number(value)})`;
  }
  if (script) {
    mainWindow.webContents.executeJavaScript(script).catch(() => {});
  }
  return { ok: true };
}

// 切换到迷你窗口显示/隐藏，并同步主界面开关状态（托盘与 IPC 共用）。
// 关闭迷你模式时恢复主窗口，避免多层被隐藏导致无法找回。
function miniToggle() {
  if (!miniWindow) return { ok: false, visible: false };
  const v = !miniWindow.isVisible();
  if (v) {
    miniWindow.showInactive();
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
  } else {
    miniWindow.hide();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("mini:visibility", v);
  }
  return { ok: true, visible: v };
}

// ---------------- 托盘 + 单实例 ----------------

function createTray() {
  const iconPath = IS_DEV
    ? path.join(__dirname, "..", "resources", "TeyvatMelody.ico")
    : path.join(process.resourcesPath, "resources", "TeyvatMelody.ico");
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  tray.setToolTip("提瓦特旋律");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 / 隐藏窗口", click: toggleMain },
      {
        label: "桌面歌词：显示 / 隐藏",
        click: () => {
          const v = lyricsWindow ? !lyricsWindow.isVisible() : true;
          lyricsSetVisible(v);
        },
      },
      {
        label: "迷你模式：显示 / 隐藏",
        click: () => miniToggle(),
      },
      { type: "separator" },
      { label: "退出", click: () => { app.isQuiting = true; app.quit(); } },
    ])
  );
  tray.on("click", toggleMain);
}

function toggleMain() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

// ---------------- IPC ----------------

// 主窗口窗口控制（preload 的 win:op）
ipcMain.handle("win:op", (_e, { op }) => {
  if (!mainWindow) return { ok: false };
  if (op === "minimize") mainWindow.minimize();
  else if (op === "toggleMaximize") {
    if (windowMode === "maximized") {
      // 还原到窗口化：回到最后一次窗口化边界（居中大窗口），不自依赖 OS 还原状态
      const target = clampToScreen(windowedBounds);
      if (target) applyBounds(target);
      windowMode = "windowed";
    } else if (windowMode === "fullscreen") {
      // 沉浸全屏中点“最大化/还原”（正常情况下标题栏被覆盖层遮挡不会触发）：
      // 当作退出沉浸并回到窗口化
      fsPrevMode = "windowed";
      mainWindow.setAlwaysOnTop(false); // 退出沉浸，取消置顶
      const target = clampToScreen(windowedBounds);
      if (target) applyBounds(target);
      windowMode = "windowed";
    } else {
      // 窗口化 → 最大化：铺满工作区（任务栏仍可见）
      applyBounds(curDisplay().workArea);
      windowMode = "maximized";
    }
  } else if (op === "close") mainWindow.hide(); // 关闭 = 最小化到托盘
  else if (op === "show") { mainWindow.show(); mainWindow.focus(); }
  return { ok: true };
});

// 沉浸全屏（沉浸播放）：进入/退出时的窗口姿态，统统用 setBounds 显式管理，不用原生最大化/全屏/kiosk。
// 根因：frame:false + thickFrame:false 的无边框窗口在 Windows 上没有 WS_THICKFRAME，原生
// maximize()/unmaximize()/getNormalBounds()/setKiosk() 都不可靠（尤其 setKiosk(true) 后 isKiosk()
// 仍返回 false，并未真正进入系统全屏；退出时还会把 OS 的"还原边界"污染成偏小/靠左上角的畸形窗口，
// 表现为沉浸退出后窗口变小、或只在隐藏/显示任务栏之间切换）。
// 方案：setBounds 铺满整块显示器即可盖住任务栏（无边框窗口实测有效），且不污染 OS 还原边界，
// 退出时 setBounds 回来即回到干净尺寸，从根上杜绝小窗口 / 左上角 / 只在任务栏间切换。
// 预期行为（与前端交互约定）：
//  - 窗口化进入沉浸：只由前端 Vue 覆盖层呈现沉浸视图，保持窗口尺寸不变（不遮任务栏）；
//  - 最大化进入沉浸：铺满整块显示器并隐藏任务栏；退出后回到最大化。

// 当前窗口所在显示器（跟随窗口位置，支持多显示器 / DPI 变化）。
function curDisplay() {
  const { screen } = require("electron");
  if (!mainWindow || mainWindow.isDestroyed()) return screen.getPrimaryDisplay();
  try {
    return screen.getDisplayMatching(mainWindow.getBounds());
  } catch (_) {
    return screen.getPrimaryDisplay();
  }
}

// 把窗口边界应用到目标值。若窗口被系统原生最大化（例如用户按 Win+↑ 快捷键），
// setBounds 会被系统忽略，须先取消原生最大化再 setBounds；即使原生"还原边界"被污染，
// 之后的目标边界也会把它覆盖，因此不会出现小窗口/左上角。
function applyBounds(bounds) {
  if (!mainWindow || mainWindow.isDestroyed() || !bounds) return;
  try {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
  } catch (_) {}
  mainWindow.setBounds(bounds);
}

// 校验并修正一块"窗口化/还原"边界：小于最小尺寸或跑到屏幕外的畸形边界 → 回退到 windowedBounds
// （启动居中大窗口，永远合法）；否则仅把位置收紧到所在显示器工作区。
function clampToScreen(bounds) {
  const cur = bounds || windowedBounds;
  if (!cur || !mainWindow || mainWindow.isDestroyed()) return cur || null;
  const [minW, minH] = mainWindow.getMinimumSize();
  const wa = curDisplay().workArea;
  const w = Math.round(cur.width);
  const h = Math.round(cur.height);
  const x = Math.round(cur.x);
  const y = Math.round(cur.y);
  if (!(w >= minW && h >= minH)) {
    return windowedBounds ? { ...windowedBounds } : { x, y, width: w, height: h };
  }
  const cw = Math.max(w, minW);
  const ch = Math.max(h, minH);
  const cx = Math.min(Math.max(x, wa.x), wa.x + Math.max(0, wa.width - cw));
  const cy = Math.min(Math.max(y, wa.y), wa.y + Math.max(0, wa.height - ch));
  return { x: cx, y: cy, width: cw, height: ch };
}

ipcMain.handle("win:fullscreen", (_e, { flag }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  const wantFs = !!flag;

  if (wantFs) {
    if (windowMode === "fullscreen") return { ok: true }; // 已是沉浸全屏
    fsPrevMode = windowMode; // 记录进入前的姿态（'windowed' | 'maximized'）
    if (windowMode === "maximized") {
      // 从最大化进入沉浸：铺满整块显示器（含任务栏区域），setBounds 即可盖住任务栏
      applyBounds(curDisplay().bounds);
      mainWindow.setAlwaysOnTop(true); // 保证盖住任务栏（即使任务栏被设为保持置顶）
      windowMode = "fullscreen";
    }
    // 窗口化进入沉浸：保持窗口尺寸不变，沉浸视图由前端覆盖层呈现（不遮任务栏）
  } else {
    if (windowMode === "fullscreen") {
      mainWindow.setAlwaysOnTop(false); // 退出沉浸，取消置顶
      if (fsPrevMode === "maximized") {
        // 退出沉浸 → 回到最大化（铺满工作区，任务栏恢复可见）
        applyBounds(curDisplay().workArea);
        windowMode = "maximized";
      } else {
        // 退出沉浸 → 回到窗口化
        const target = clampToScreen(windowedBounds);
        if (target) applyBounds(target);
        windowMode = "windowed";
      }
    }
    fsPrevMode = "windowed";
  }
  return { ok: true };
});

// 手动窗口拖拽：绕开 -webkit-app-region: drag。Chromium 在含 backdrop-filter 的窗口里
// 会把 CSS 拖拽区错误映射到整窗并吞掉真实点击（按钮失效），故改为主进程跟随光标移动。
// 窗口随光标同速移动，光标始终停留在标题栏上，前端能稳定收到 mouseup 以结束拖拽。
let mainDragState = null;
ipcMain.handle("win:drag-start", () => {
  if (!mainWindow || mainWindow.isDestroyed() || mainDragState) return { ok: false };
  // 沉浸全屏 / 最大化 下禁止拖动，避免窗口"向内变小"：
  // - 沉浸全屏：getContentSize() 为整屏，用 setContentBounds 重设边界会让窗口从全屏向内收缩；
  // - 最大化：若先 unmaximize 再拖拽，窗口会从铺满屏幕瞬间还原成较小尺寸，同样表现为"变小"。
  // 标题栏拖动只在窗口化状态下生效；想移动最大化窗口时，先经标题栏"最大化/还原"按钮还原再拖拽。
  if (windowMode !== "windowed") return { ok: false };
  const { screen } = require("electron");
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = mainWindow.getPosition();
  // 用内容区尺寸而非整体尺寸：对无边框窗口（frame:false）反复 setPosition/setBounds 时，
  // Windows/DWM 会额外套一层透明边框，使 getSize() 每次 +1px 漂移（实测：移动一次 +1）。
  // getContentSize() 不包含这层 DWM 边框，可作为稳定的"窗口真实内容大小"，随拖拽钳制不变。
  const [baseW, baseH] = mainWindow.getContentSize();
  mainDragState = { offsetX: cursor.x - wx, offsetY: cursor.y - wy, lastX: cursor.x, lastY: cursor.y, baseW, baseH };
  // 拖拽期间临时禁用可缩放/可最大化：Windows 的 Aero Snap（边缘吸附）只作用于
  // 可缩放窗口。若不关闭，把窗口拖到屏幕顶/左右边缘时会被系统吸附并放大成全屏/半屏，
  // 表现为"拖动时窗口自己变大"。拖拽结束后恢复原状态。
  mainDragState.wasResizable = mainWindow.isResizable();
  mainDragState.wasMaximizable = mainWindow.isMaximizable();
  mainWindow.setResizable(false);
  mainWindow.setMaximizable(false);
  mainDragState.timer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(mainDragState.timer);
      mainDragState = null;
      return;
    }
    // 拖拽过程中若窗口已切到沉浸全屏/最大化，立即中止拖拽，避免 setContentBounds
    // 把整屏窗口重设为局部大小而产生"向内收缩"。
    if (windowMode !== "windowed") {
      clearInterval(mainDragState.timer);
      mainWindow.setResizable(mainDragState.wasResizable);
      mainWindow.setMaximizable(mainDragState.wasMaximizable);
      mainDragState = null;
      return;
    }
    const c = screen.getCursorScreenPoint();
    // 位置去重：光标未移动（长按不动）时不调用 setPosition。避免高频对同一坐标 setPosition。
    if (c.x === mainDragState.lastX && c.y === mainDragState.lastY) return;
    mainDragState.lastX = c.x;
    mainDragState.lastY = c.y;
    // 关键：不用 setPosition/setBounds —— 对无边框窗口反复 setPosition 会让 Windows/DWM 每次
    // 重新应用一层隐形边框，导致整体宽高每次 +1px 漂移（实测：移动一次 +1，累积到 1208x808）。
    // 改用 setContentBounds 并钉死内容区尺寸 baseW x baseH，DWM 边框不进入内容区，尺寸再无累积漂移。
    const nx = Math.round(c.x - mainDragState.offsetX);
    const ny = Math.round(c.y - mainDragState.offsetY);
    mainWindow.setContentBounds({ x: nx, y: ny, width: mainDragState.baseW, height: mainDragState.baseH });
  }, 12);
  return { ok: true };
});
ipcMain.handle("win:drag-end", () => {
  if (mainDragState) {
    clearInterval(mainDragState.timer);
    // 恢复拖拽前的可缩放/可最大化状态
    mainWindow.setResizable(mainDragState.wasResizable);
    mainWindow.setMaximizable(mainDragState.wasMaximizable);
    mainDragState = null;
  }
  // 拖动结束：记录最新的窗口化边界（拖动后的位置与尺寸），供最大化/沉浸还原回来时恢复到这里
  if (mainWindow && !mainWindow.isDestroyed() && windowMode === "windowed") {
    const b = mainWindow.getBounds();
    windowedBounds = clampToScreen(b);
  }
  return { ok: true };
});

// 桌面歌词窗口控制
function lyricsSetVisible(v) {
  if (!lyricsWindow) return { ok: false, visible: false };
  syncLyricsSize();
  if (v) {
    lyricsWindow.showInactive();
    if (lastLyrics && Object.keys(lastLyrics).length) {
      lyricsWindow.webContents.send("lyrics:update", lastLyrics);
    }
  } else {
    lyricsWindow.hide();
  }
  saveLyricSettings({ visible: !!v });
  // 广播可见性变化 → 主窗口同步桌面歌词开关状态
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("lyrics:visibility", v);
  }
  return { ok: true, visible: v };
}

ipcMain.handle("lyrics:toggle", () => {
  const v = lyricsWindow ? !lyricsWindow.isVisible() : true;
  return lyricsSetVisible(v);
});
ipcMain.handle("lyrics:hide", () => lyricsSetVisible(false));
ipcMain.handle("lyrics:push", (_e, { args }) => {
  const payload = args && args[0];
  if (payload && typeof payload === "object") {
    // 合并增量载荷进 lastLyrics，再整体发送给歌词窗口，避免丢失歌词/设置
    lastLyrics = mergeLyrics(lastLyrics, payload);
    syncLyricsSize();
    if (lyricsWindow && lyricsWindow.isVisible()) {
      lyricsWindow.webContents.send("lyrics:update", lastLyrics);
    }
  }
  return { ok: true };
});
ipcMain.handle("lyrics:get", () => lastLyrics);
ipcMain.handle("lyrics:getState", () => ({
  visible: !!(lyricsWindow && lyricsWindow.isVisible()),
  payload: lastLyrics,
}));
ipcMain.handle("lyrics:doubleclick", () => {
  // 双击桌面歌词 → 主窗口切换播放/暂停（App.vue 暴露了 window.__togglePlay）
  if (mainWindow) {
    mainWindow.webContents.executeJavaScript(
      "window.__togglePlay && window.__togglePlay()"
    );
  }
  return { ok: true };
});
// 歌词窗口工具栏播放控制 → 转发到主窗口
ipcMain.handle("lyrics:togglePlay", () => {
  if (mainWindow) {
    mainWindow.webContents.executeJavaScript(
      "window.__togglePlay && window.__togglePlay()"
    );
  }
  return { ok: true };
});
ipcMain.handle("lyrics:prev", () => {
  if (mainWindow) {
    mainWindow.webContents.executeJavaScript("window.__prev && window.__prev()");
  }
  return { ok: true };
});
ipcMain.handle("lyrics:next", () => {
  if (mainWindow) {
    mainWindow.webContents.executeJavaScript("window.__next && window.__next()");
  }
  return { ok: true };
});
// 桌面歌词滚轮调字号 → 转发到主窗口，更新 config.dlFontSize 并广播回歌词窗口
ipcMain.handle("lyrics:setFontSize", (_e, { delta }) => {
  if (mainWindow && Number.isFinite(delta)) {
    mainWindow.webContents.executeJavaScript(
      `window.__setDlFontSize && window.__setDlFontSize(${delta})`
    );
  }
  return { ok: true };
});

// 前端其余 window.pywebview.api.* → Flask RPC
ipcMain.handle("py:rpc", async (_e, { method, args }) => {
  const res = await fetch(BACKEND_URL + "/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args: args || [] }),
  });
  const body = await res.json();
  if (body.code !== 200) throw new Error(body.message || "RPC failed");
  return body.data;
});

// ---------------- 系统级全局快捷键（后台/最小化时遥控播放） ----------------
// 通过 globalShortcut 注册媒体键，即使主窗口隐藏到托盘也能切歌/播放暂停。
// 由于无边框窗口隐藏时不触发渲染进程 keydown，这里把按键转发到主窗口的全局钩子，
// 与桌面歌词窗口的播放控制走同一套 window.__togglePlay / __prev / __next。
const HOTKEY_ACTIONS = new Map([
  ["MediaPlayPause", "window.__togglePlay && window.__togglePlay()"],
  ["MediaTrackNext", "window.__next && window.__next()"],
  ["MediaTrackPrevious", "window.__prev && window.__prev()"],
]);

function applyGlobalHotkeys(enabled) {
  const registered = [];
  if (!enabled) {
    globalShortcut.unregisterAll();
    return registered;
  }
  for (const [accelerator, script] of HOTKEY_ACTIONS) {
    try {
      if (globalShortcut.register(accelerator, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.executeJavaScript(script).catch(() => {});
        }
      })) {
        registered.push(accelerator);
      }
    } catch (_) {
      /* 个别系统键被占用时忽略，不中断其余注册 */
    }
  }
  return registered;
}

ipcMain.handle("hotkeys:apply", (_e, { enabled }) => {
  return { ok: true, registered: applyGlobalHotkeys(!!enabled) };
});

// ---------------- 自定义源（洛雪源脚本宿主） ----------------
// sources/ 目录与 sources.json 都在软件根目录（dataRoot），符合根目录存储约定。
const sourceManager = new SourceManager(dataRoot());
// 歌词缓存与音频缓存同放软件根目录 cache/ 下（设置页「清空缓存」会一并清掉）
onlineLyric.setCacheDir(path.join(dataRoot(), "cache", "lyrics"));

ipcMain.handle("source:list", () => ({ ok: true, list: sourceManager.list() }));

ipcMain.handle("source:import", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "导入自定义源脚本",
    filters: [{ name: "洛雪自定义源", extensions: ["js"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  try {
    const summary = await sourceManager.importFrom(r.filePaths[0]);
    return { ok: true, source: summary };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("source:remove", async (_e, { id }) => {
  return { ok: await sourceManager.remove(id) };
});

ipcMain.handle("source:toggle", async (_e, { id, enabled }) => {
  return { ok: await sourceManager.toggle(id, enabled) };
});

ipcMain.handle("source:reload", async (_e, { id }) => {
  return { ok: await sourceManager.reload(id) };
});

// 在线歌曲取真实播放 URL：音质降级链 + 多源换源重试全部在主进程完成，
// 渲染进程只拿到最终可播放的 CDN URL（失败时返回 message 供 toast 展示）。
ipcMain.handle("online:getUrl", async (_e, { source, musicInfo, quality }) => {
  try {
    const r = await sourceManager.resolveMusicUrl(source, musicInfo || {}, quality);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

// 当前"可播放"的搜索平台：必须有已启用源声明支持，否则搜到也播不了。
// 同时回传各平台源声明支持的音质（供 UI 展示"最高可用音质"，实际取哪个由播放时降级链决定）。
function playablePlatforms() {
  return Object.keys(sourceManager.enabledSources()).filter((k) =>
    onlineSearch.DEFAULT_SOURCES.includes(k)
  );
}

ipcMain.handle("online:platforms", () => {
  const caps = sourceManager.enabledSources();
  const platforms = playablePlatforms();
  const qualitys = {};
  for (const k of platforms) qualitys[k] = caps[k]?.qualitys || [];
  // 带上各平台最近的解析失败记录：源声明支持某平台、实际却解析不出地址时，
  // 界面可提前提示，避免用户「搜得到却播不了」。
  return { ok: true, platforms, qualitys, warnings: sourceManager.platformWarnings() };
});

// 在线歌曲歌词：优先用源声明的 lyric 能力，否则走平台歌词接口。
// 主进程解析成 lines（翻译已内联进 text、逐字已展开为 words），渲染进程零解析。
//
// 歌词缓存开关与音频缓存共用同一份配置（cache/config.json 由 Flask 端读写），
// 这里在每次取歌词前读一次 —— 文件只有几百字节，且只在切歌时发生，代价可忽略；
// 好处是用户在设置页关掉缓存后，下一次切歌就立刻不再写盘。
function onlineCacheEnabled() {
  return appConfig.readConfig().enabled !== false; // 配置不存在 / 损坏 → 默认开启（与后端一致）
}

/**
 * 以「流式下载到文件」的方式发一次 GET，并回报进度。
 *
 * 刻意用原生 `http`/`https` 而不是 `fetch`：项目零运行时依赖，而主进程内 `require("undici")`
 * 拿不到（Node 内置但没暴露），所以 `fetch` 想走用户配置的 HTTP 代理做不到 —— 只能走原生请求
 * + 自写的 CONNECT 隧道 agent（见 proxyAgent.js）。更新包有 90 多 MB，正好也要流式落盘。
 *
 * @returns {Promise<{status:number, headers:object, stream:import("stream").Readable, cleanup:Function}>}
 */
function httpGetStream(url, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`非法 URL：${url}`));
    }
    // ⚠️ 本机地址永远直连：通知图标传进来的其实是本机封面代理的 URL
    //（http://127.0.0.1:<后端端口>/api/online/image?...），塞进代理就会拉不到图。
    const proxy = proxyAgent.effectiveProxy(url, appConfig.proxyConfig());
    const lib = u.protocol === "https:" ? require("https") : require("http");
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: { "User-Agent": "TeyvatMelody", Accept: "*/*" },
    };
    const req = lib.request(proxyAgent.withProxyOptions(opts, proxy), (res) => {
      const total = Number(res.headers["content-length"]) || 0;
      let received = 0;
      // 手动计数而不是套一层 Transform：调用方拿到的是原始 res，行为可与之前完全一致
      res.on("data", (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        stream: res,
        cleanup: () => res.destroy(),
      });
    });
    req.on("error", reject);
    req.end();
  });
}

ipcMain.handle("online:lyric", async (_e, { source, musicInfo }) => {
  try {
    onlineLyric.setCacheEnabled(onlineCacheEnabled());
    const r = await onlineLyric.fetchLyric(source, musicInfo || {}, sourceManager);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, lines: [], message: e.message };
  }
});

// 在线搜索：搜索走平台公开接口（与自定义源无关），但只查有源支持的平台。
// page 从 1 开始；翻页由渲染进程累加，主进程只负责透传给各平台适配器。
ipcMain.handle("online:search", async (_e, { keyword, sources, page }) => {
  const available = playablePlatforms();
  // ⚠️ 必须区分「一个平台都没勾选」和「根本没导入源」—— 旧实现把两者合并成
  // 「尚未启用任何自定义源」，于是用户在界面上取消掉所有平台后会看到一条
  // 指向设置页的误导提示（明明源是好的，只是他自己没勾平台）。
  const picked = (Array.isArray(sources) && sources.length ? sources : available).filter((s) =>
    available.includes(s)
  );
  if (!picked.length) {
    return {
      ok: false,
      list: [],
      errors: [],
      availableSources: available,
      message: available.length
        ? "没有勾选任何搜索平台，请在搜索框右侧至少选择一个平台"
        : "尚未启用任何支持在线播放的自定义源，请先在「设置 → 自定义源」导入并启用",
    };
  }
  try {
    onlineSearch.setProxy(appConfig.proxyConfig());
    const r = await onlineSearch.search(keyword, picked, undefined, page);
    return { ok: true, ...r, availableSources: available };
  } catch (e) {
    return { ok: false, list: [], errors: [], availableSources: available, message: e.message };
  }
});

// ---------------- 检查更新 / 下载 / 拉起安装 ----------------
// 更新包下到系统临时目录，不污染用户目录；安装完成后由安装程序自行清理。
const UPDATE_DIR = () => path.join(app.getPath("temp"), "TeyvatMelody-update");
// 只允许从 GitHub 的发布域名下载，避免这段能力被当成任意下载器
const UPDATE_URL_OK = /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//i;

// 注：isInstalledBuild() / dataRoot() / installDir() 定义在文件开头 ——
// 数据根目录的选址要用到「是否安装版」，而那必须在 app ready 之前完成。

// 当前应用版本（设置页「关于」展示用）
ipcMain.handle("app:version", () => app.getVersion());

// 数据目录（data / music / cache / sources 都在它下面）—— 设置页展示，用户能自己确认数据在哪
ipcMain.handle("app:dataDir", () => dataRoot());

// 在系统资源管理器里打开数据目录（不存在就先建出来，避免打开失败）
ipcMain.handle("app:openDataDir", async () => {
  const dir = dataRoot();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来也让 shell 试一次，失败会有返回值 */
  }
  const err = await shell.openPath(dir);
  return { ok: !err, message: err || "" };
});

/**
 * 以「读-改-写」方式更新 `cache/config.json` 里的字段，**保留其它键**。
 *
 * ⚠️ 后端的 `save_config()` 是白名单实现，会**整体重写**这个文件且只保留它认识的键
 * （enabled / maxBytes）。所以从主进程写配置时如果也整文件覆盖，就可能把后端的键抹掉；
 * 反过来后端写也会抹掉我们的 proxy。两边都必须在**已读过的最新内容**上打补丁 ——
 * 这也是这里不直接 writeFile 一个常量对象的原因。
 */
function writeConfigPatch(patch) {
  const p = appConfig.configPath();
  const cur = appConfig.readConfig();
  const next = { ...cur, ...patch };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next), "utf8");
  } catch (e) {
    console.error("[config] 写入失败:", e.message);
  }
  return next;
}

/** 把最新的代理配置推给常驻模块（源脚本宿主、搜索/歌词请求都靠它） */
function applyProxyToModules() {
  const proxy = appConfig.proxyConfig();
  sourceManager.setProxy(proxy);
  onlineSearch.setProxy(proxy);
  return proxy;
}

// ---------------- 网络代理设置 ----------------
// 代理配置与在线缓存共用 `cache/config.json`（见 appConfig.js 的说明）。
// 主进程每次联网前现读一次文件，所以这里不需要维护缓存失效 —— 但**源脚本与搜索模块**
// 是常驻对象，得把新值推给它们，故保存后立刻 setProxy。
ipcMain.handle("proxy:get", () => {
  const proxy = appConfig.proxyConfig();
  return { ok: true, proxy: { enabled: proxy.enabled, host: proxy.host, port: proxy.port } };
});

ipcMain.handle("proxy:set", (_e, { enabled, host, port }) => {
  const { validateProxySave } = require("./proxy");
  // 校验规则在 proxy.js（纯函数，有单测）。这里的两种拒绝情形见那边的注释：
  // 启用却填不全、以及「关着开关但填错了」，都不能放行。
  const r = validateProxySave({ enabled, host, port });
  if (!r.ok) return r;
  const saved = writeConfigPatch({ proxy: r.proxy });
  applyProxyToModules();
  return { ok: true, proxy: saved.proxy, effective: !!r.proxy.enabled };
});

/**
 * 试连一次代理，验证「主机:端口」真的可用。
 *
 * 刻意请求 `https://api.github.com` 而不是随便一个地址：它是本项目实际依赖的域名之一
 * （更新检查走它），而且走 HTTPS 才能同时验证 CONNECT 隧道与 TLS 两段。
 * 只报结果，不改配置。
 */
ipcMain.handle("proxy:test", async (_e, { host, port }) => {
  const { normalizeProxy } = require("./proxy");
  const { createProxiedSocket } = require("./proxyAgent");
  const proxy = normalizeProxy({ enabled: true, host, port });
  if (!proxy.enabled) return { ok: false, message: "代理主机或端口无效" };
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => finish({ ok: false, message: "连接超时（10 秒）" }), 10000);
    createProxiedSocket(
      proxy,
      { host: "api.github.com", port: 443, servername: "api.github.com", isHttps: true },
      (err, socket) => {
        clearTimeout(timer);
        if (err) return finish({ ok: false, message: err.message });
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        finish({ ok: true, message: `隧道建立成功（${proxy.host}:${proxy.port}）` });
      }
    );
  });
});

// 查 GitHub Release 的最新版本并与当前版本比对；失败不抛错，返回 ok=false 供界面提示。
// 顺带回传「是否安装版」与「按分发方式挑好的下载项」，界面据此决定按钮文案与后续动作。
ipcMain.handle("update:check", async () => {
  // 先注入最新代理配置：用户可能刚在设置页改过，而 updater 的 fetch 需要它
  const r = await updater.checkForUpdate(app.getVersion(), { proxy: appConfig.proxyConfig() });
  if (!r.ok) return r;
  const installed = isInstalledBuild();
  return { ...r, installed, asset: updater.pickAssetFor(r.assets, installed) };
});

// 下载更新包（流式写入 + 进度事件）。渲染进程用 update:progress 监听进度。
ipcMain.handle("update:download", async (e, { url, name }) => {
  if (!UPDATE_URL_OK.test(url || "")) return { ok: false, message: "下载地址不被允许" };
  const dir = UPDATE_DIR();
  const safe = path.basename(String(name || "update.bin")).replace(/[^\w.-]/g, "_") || "update.bin";
  const dest = path.join(dir, safe);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let lastSent = 0;
    const report = (percent) => {
      try {
        e.sender.send("update:progress", { percent, received, total });
      } catch {
        /* 窗口可能已关闭 */
      }
    };
    let received = 0;
    let total = 0;
    // 走原生请求 + 代理（不能用 fetch：见 httpGetStream 的说明）
    const res = await httpGetStream(url, {
      onProgress: (got, all) => {
        received = got;
        total = all;
        const now = Date.now();
        if (now - lastSent > 300) {
          lastSent = now;
          report(total ? Math.round((received / total) * 100) : 0);
        }
      },
    });
    if (res.status !== 200) {
      res.cleanup();
      return { ok: false, message: `HTTP ${res.status}` };
    }
    await pipeline(res.stream, fs.createWriteStream(dest));
    report(100);
    return { ok: true, path: dest, size: received };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

// 拉起安装包：仅允许运行下载目录里的文件。
// reveal=true 时不运行，而是在资源管理器里定位（免安装版下载 zip 后由用户自行解压）。
ipcMain.handle("update:install", async (_e, { path: filePath, reveal }) => {
  const dir = path.resolve(UPDATE_DIR());
  const full = path.resolve(String(filePath || ""));
  if (full !== dir && !full.startsWith(dir + path.sep)) return { ok: false, message: "路径不被允许" };
  if (!fs.existsSync(full)) return { ok: false, message: "安装包不存在" };
  const plan = updater.installAction(reveal);
  if (plan.action === "reveal") {
    shell.showItemInFolder(full);
    return { ok: true, revealed: true };
  }
  const err = await shell.openPath(full);
  if (err) return { ok: false, message: err };
  // 安装程序要替换 TeyvatMelody.exe 与 resources/ 下的文件，而**当前进程正持有这些句柄** ——
  // 不退出的话 NSIS 会卡在「文件被占用」或让用户手动关。这里主动退出。
  //
  // ⚠️ 早先这里是一个固定 1500ms 的 setTimeout，**实测没退出**：exe 有 93MB，
  //    `shell.openPath` 返回时安装程序进程才刚起来，画完向导窗口要好几秒；
  //    这期间我们的 before-quit 会 kill 后端，而 NSIS 也会反过来 taskkill 我们，
  //    两边一起动手 → 安装程序自己先没了，用户只看到「软件没关」。
  //    改法见 updater.installQuitDecision：等它**真的稳定运行**再退，而不是赌一个固定延时。
  if (plan.quitAfter) {
    watchInstallerThenQuit(full);
  }
  return { ok: true, willQuit: plan.quitAfter };
});

/**
 * 等安装程序稳定运行后再退出本应用（不要用固定延时赌 —— 见 update:install 处的说明）。
 *
 * 采样方式用 `tasklist /FI "IMAGENAME eq <name>"`：
 * 安装器 PID 拿不到（shell.openPath 只返回错误信息），但我们在下载时已经限定了
 * 「同一个安装包只允许跑一个」，所以按映像名判定是可靠的。
 */
function watchInstallerThenQuit(installerPath) {
  const imageName = path.basename(installerPath);
  const startedAt = Date.now();
  let seenWindow = false;

  const isAlive = () =>
    new Promise((resolve) => {
      // 映像名来自下载目录、已过 basename + 白名单过滤，这里再加一层引号防护
      execFile("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/NH"], (e, stdout) => {
        if (e) return resolve({ alive: false, hasWindow: false });
        // 无匹配时 tasklist 输出「信息: 没有运行的任务匹配指定标准」之类的提示行，
        // 不会含映像名；有匹配时每行以 "映像名称" 开头 → 直接找文件名最稳。
        const alive = String(stdout || "").includes(imageName);
        resolve({ alive, hasWindow: alive });
      });
    });

  const tick = async () => {
    const { alive, hasWindow } = await isAlive();
    if (alive) seenWindow = true;
    const decision = updater.installQuitDecision({
      alive,
      elapsedMs: Date.now() - startedAt,
      hasWindow,
      seenWindow,
    });
    if (decision === "quit") {
      app.isQuiting = true;
      app.quit();
      return;
    }
    if (decision === "abort") {
      // 安装程序压根没起来：别退，否则用户既没装上、界面也没了
      console.error("[update] 安装程序未启动，已取消自动退出");
      return;
    }
    setTimeout(tick, 500);
  };

  // 先让渲染进程把「即将关闭」提示显示出来，再开始盯安装程序
  setTimeout(tick, 800);
}

// 用系统浏览器打开更新页 / 下载链接。
// 只放行 https 且限定 GitHub 域名：该 URL 虽由主进程提供，仍收紧一层避免被当作任意跳板。
ipcMain.handle("update:open", (_e, { url }) => {
  if (typeof url !== "string" || !/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//i.test(url)) {
    return { ok: false };
  }
  shell.openExternal(url);
  return { ok: true };
});

// ---------------- 切歌桌面通知 ----------------
// 渲染进程切换歌曲时调用，用系统通知展示当前歌曲信息；点击通知聚焦主窗口。
ipcMain.handle("notify:song", async (_e, { title, artist, songId, iconUrl }) => {
  if (!Notification.isSupported()) return { ok: false };
  const body = artist ? `${title} - ${artist}` : title;
  const opts = { title: "提瓦特旋律", body, silent: true };
  // 在线歌曲：顺手把封面拉成 NativeImage 当通知图标（失败就退回默认，不影响通知本身）
  if (iconUrl) {
    try {
      const res = await httpGetStream(iconUrl);
      if (res.status === 200) {
        const chunks = [];
        for await (const c of res.stream) chunks.push(c);
        const img = nativeImage.createFromBuffer(Buffer.concat(chunks));
        if (!img.isEmpty()) opts.icon = img;
      } else {
        res.cleanup();
      }
    } catch {
      /* 通知图标非关键，忽略 */
    }
  }
  const n = new Notification(opts);
  n.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  n.show();
  return { ok: true };
});

// ---------------- 迷你模式 IPC ----------------
// 切换迷你窗口显示/隐藏；主窗口隐藏或关闭后仍可显示小窗。
ipcMain.handle("mini:toggle", () => miniToggle());
ipcMain.handle("mini:push", (_e, { snapshot }) => {
  return miniPushState(snapshot);
});
ipcMain.handle("mini:controls", (_e, { op, t }) => {
  return miniControl(op, t);
});
ipcMain.handle("mini:close", () => {
  if (miniWindow) miniWindow.hide();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("mini:visibility", false);
  }
  return { ok: true, visible: false };
});

// ---------------- 生命周期 ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 尽早拉起后端子进程（端口选定后立即 spawn），与 Electron 初始化并行，缩短首屏等待
  backendBoot.catch((e) => console.error("[backend] 启动失败:", e.message));
  app.on("second-instance", () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    // 立即创建窗口并展示本地加载页；后端就绪后再载入 SPA，减少"无窗口"等待
    createMainWindow();
    createLyricsWindow();
    createMiniWindow();
    createTray();
    // 恢复上次的桌面歌词可见性（默认隐藏）
    if (loadLyricSettings().visible) lyricsSetVisible(true);
    // 先把代理配置推给常驻模块（源宿主 / 搜索），**必须在 init 之前** ——
    // 源脚本的 inited 握手本身就要访问源后端，晚了第一次握手就走了直连。
    applyProxyToModules();
    // 加载自定义源（沙箱执行源脚本，inited 握手）
    sourceManager.init().catch((e) => console.error("自定义源初始化失败:", e.message));
    app.on("activate", () => {
      if (mainWindow) mainWindow.show();
    });

    const ok = await waitBackend();
    if (!ok) {
      console.error("后端启动失败");
      // 页面会显示连接失败，不阻塞其余功能
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(BACKEND_URL); // 后端就绪后载入实际 SPA
    }
  });

  app.on("before-quit", () => {
    app.isQuiting = true;
    globalShortcut.unregisterAll();
    if (backendProc) {
      try { backendProc.kill(); } catch (_) { /* ignore */ }
    }
  });

  app.on("window-all-closed", (e) => {
    // 托盘常驻：不自动退出
    e.preventDefault();
  });
}
