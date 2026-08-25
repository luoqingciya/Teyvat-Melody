// Teyvat Melody - Electron 主进程
// 职责：spawn Python(Flask) 后端子进程、主窗口、系统托盘、单实例、
//       透明桌面歌词窗口、IPC 路由（窗口控制 / 歌词推送 / Flask RPC 代理）。
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, globalShortcut, Notification, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const BACKEND_URL = "http://127.0.0.1:5000";
const IS_DEV = !app.isPackaged;

// 把所有 Electron 端数据（桌面歌词设置、前端 localStorage 的配置/音量/播放进度/队列/歌词锁定等）
// 统一放到软件根目录下，符合"运行产生的数据都在软件根目录"的约定。
// 必须在创建任何窗口之前调用 app.setPath 重定向 userData。
function dataRoot() {
  // 打包：exe 所在目录（<根目录>/TeyvatMelody.exe）；开发：项目根目录
  return IS_DEV ? path.resolve(__dirname, "..") : path.resolve(process.execPath, "..");
}
(function ensureUserDataUnderRoot() {
  const prevUserData = app.getPath("userData");
  const newUserData = path.join(dataRoot(), ".appdata");
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
let launchBounds = null; // 启动时的窗口边界（居中大窗口），作为还原兜底
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
  backendProc = spawn(cmd, args, { cwd, stdio: "ignore" });
  backendProc.on("exit", (code) => {
    console.log("[backend] exited:", code);
    backendProc = null;
  });
}

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
  // 记录启动时真实窗口边界（含 DWM 边框微调），作为窗口化还原的兜底
  launchBounds = mainWindow.getBounds();
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
    if (mainWindow.isMaximized()) {
      // 还原到窗口化：先取“还原边界”，unmaximize 后立即吸附到合法边界，
      // 避免 unmaximize 使用被竞态污染的还原尺寸，出现偏小/靠左上角的窗口。
      const nb = mainWindow.getNormalBounds();
      mainWindow.unmaximize();
      const target = clampToScreen(nb);
      if (target) mainWindow.setBounds(target);
    }
    else mainWindow.maximize();
  } else if (op === "close") mainWindow.hide(); // 关闭 = 最小化到托盘
  else if (op === "show") { mainWindow.show(); mainWindow.focus(); }
  return { ok: true };
});

// 沉浸全屏：进入/退出原生全屏以覆盖任务栏。
// 注意：前端 FullscreenPlayer 只是 Vue 覆盖层（position:fixed; inset:0），不会覆盖任务栏；
// 真正屏蔽任务栏需要窗口在系统层面进入原生全屏。对 frame:false + thickFrame:false 的无边框窗口，
// setFullScreen(true) 在部分 Windows 环境只把窗口放到工作区大小（任务栏仍可见），故改用 setKiosk。
//
// 预期行为（与前端交互约定）：
//  - 普通（未最大化）窗口进入沉浸播放：只由前端覆盖层呈现沉浸视图，保持窗口尺寸不变；
//  - 最大化窗口进入沉浸播放：真正占满整块显示器并隐藏任务栏（先在普通态再进 kiosk，否则 Windows
//    不会从最大化直接切到覆盖任务栏的全屏，表现就是"占满但任务栏仍在"）。
let wasMaximizedBeforeFs = false;
// 进入全屏（由最大化进入）前的“正常/还原”边界：退出时据此还原为居中大窗口，
// 避免 unmaximize + setKiosk 的竞态把还原边界污染成“小窗口 / 靠左上角”。
let fsRestoreBounds = null;
// 记录当前是否处于"沉浸全屏"（进入全屏的意图状态）。关键点：对 frame:false + thickFrame:false 的无边框
// 窗口，Windows 下 setKiosk(true) 后 isKiosk() 仍可能返回 false，因此不能只用 isKiosk()/isFullScreen()
// 作为守卫依据，须用自维护标志让拖拽/窗口控制保持可靠。
let nativeFullscreen = false;
// 校验并修正还原边界：小于最小尺寸或跑到屏幕外的"畸形"边界，直接回退到启动时的居中大窗口；
// 否则仅把位置收紧到工作区（DWM/竞态所致的小窗口/左上角由此被兜底修复）。
function clampToScreen(bounds) {
  const cur = bounds || launchBounds;
  if (!cur || !mainWindow || mainWindow.isDestroyed()) return cur || null;
  const [minW, minH] = mainWindow.getMinimumSize();
  const { screen } = require("electron");
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.round(cur.width);
  const h = Math.round(cur.height);
  const x = Math.round(cur.x);
  const y = Math.round(cur.y);
  if (!(w >= minW && h >= minH)) {
    return launchBounds ? { ...launchBounds } : { x, y, width: w, height: h };
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
    // 已是沉浸全屏：无需重复处理
    if (nativeFullscreen || mainWindow.isKiosk() || mainWindow.isFullScreen()) return { ok: true };
    if (mainWindow.isMaximized()) {
      // 从最大化 state 直接 setKiosk 不会隐藏任务栏（窗口仍按最大化/工作区处理），
      // 先还原成普通窗口再进入 kiosk，kiosk 会强制窗口覆盖整块显示器并遮蔽任务栏。
      wasMaximizedBeforeFs = true;
      fsRestoreBounds = clampToScreen(mainWindow.getNormalBounds());
      mainWindow.unmaximize();
      if (fsRestoreBounds) mainWindow.setBounds(fsRestoreBounds);
      mainWindow.setKiosk(true);
    }
    // 普通窗口：不进入原生全屏，保持窗口大小不变（沉浸视图由前端覆盖层呈现）。
    nativeFullscreen = true;
  } else {
    // 退出沉浸全屏：无条件清掉原生全屏/kiosk 态。
    // 不能写成 if (isKiosk()) setKiosk(false)：该环境下 setKiosk(true) 后 isKiosk() 仍为 false，
    // 用 isKiosk() 判断会跳过 setKiosk(false)，窗口残留 kiosk 全屏样式，导致随后点"窗口化/最大化"
    // 只在隐藏、显示任务栏之间切换，无法回到普通窗口。
    mainWindow.setKiosk(false);
    mainWindow.setFullScreen(false);
    // 进入前是最大化 → 退出后还原为最大化，尽量不丢失窗口状态
    if (wasMaximizedBeforeFs) {
      mainWindow.setResizable(true);
      // 显式回到“进入前”的正常边界再最大化，确保之后的“窗口化”是居中大窗口而非小窗/左上角
      const target = clampToScreen(fsRestoreBounds);
      if (target) mainWindow.setBounds(target);
      mainWindow.maximize();
    }
    wasMaximizedBeforeFs = false;
    fsRestoreBounds = null;
    nativeFullscreen = false;
  }
  return { ok: true };
});

// 手动窗口拖拽：绕开 -webkit-app-region: drag。Chromium 在含 backdrop-filter 的窗口里
// 会把 CSS 拖拽区错误映射到整窗并吞掉真实点击（按钮失效），故改为主进程跟随光标移动。
// 窗口随光标同速移动，光标始终停留在标题栏上，前端能稳定收到 mouseup 以结束拖拽。
let mainDragState = null;
ipcMain.handle("win:drag-start", () => {
  if (!mainWindow || mainWindow.isDestroyed() || mainDragState) return { ok: false };
  // 原生全屏 / 沉浸 kiosk / 最大化 下禁止拖动，避免窗口"向内变小"：
  // - 全屏 / kiosk：getContentSize() 为整屏，用 setContentBounds 重设边界会让窗口从全屏向内收缩；
  // - 最大化：若先 unmaximize 再拖拽，窗口会从铺满屏幕瞬间还原成较小的默认尺寸，同样表现为"变小"。
  // 标题栏拖动只在普通（未最大化、非全屏）状态下生效；想移动最大化窗口时，先经标题栏"最大化/还原"
  // 按钮还原为普通尺寸再拖拽即可。
  if (nativeFullscreen || mainWindow.isFullScreen() || mainWindow.isKiosk() || mainWindow.isMaximized()) return { ok: false };
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
    // 拖拽过程中若用户进入沉浸全屏（kiosk/原生全屏），立即中止拖拽，避免 setContentBounds
    // 把全屏窗口重设为局部大小而产生"向内收缩"。
    if (nativeFullscreen || mainWindow.isFullScreen() || mainWindow.isKiosk()) {
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

// ---------------- 切歌桌面通知 ----------------
// 渲染进程切换歌曲时调用，用系统通知展示当前歌曲信息；点击通知聚焦主窗口。
ipcMain.handle("notify:song", (_e, { title, artist, songId }) => {
  if (!Notification.isSupported()) return { ok: false };
  const body = artist ? `${title} - ${artist}` : title;
  const n = new Notification({ title: "提瓦特旋律", body, silent: true });
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
  // 尽早拉起后端子进程，与 Electron 初始化并行，缩短首屏等待
  startBackend();
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
