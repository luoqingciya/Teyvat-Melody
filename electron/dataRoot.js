// 数据根目录选址。
//
// **为什么安装版不能把数据放在安装目录里**：安装版升级时，NSIS 安装器会先执行旧版的
// 卸载程序（app-builder-lib/templates/nsis/installSection.nsh 的 uninstallOldVersion），
// 而卸载程序会 `RMDir /r $INSTDIR`（uninstaller.nsh）—— 把安装目录整个删掉。
// 数据若放在里面，**每次更新都会丢光**（这是真实发生过的缺陷，用户报过）。
//
// 于是按分发方式分开：
//   · 免安装版 / 开发模式 → 软件根目录（<根>/data、music…），整个文件夹可随意搬移
//   · 安装版            → %LOCALAPPDATA%\TeyvatMelody，升级/卸载都不会碰它
//
// 判据：exe 同级有没有 `Uninstall *.exe`（只有安装版才带卸载程序）。
//
// ⚠️ 这套规则与后端 `app/utils/paths.py` 必须完全一致（两边各自要独立算数据目录），
// 改一处就要同步改另一处，并各自跑自检（tests/data-root.test.js / tests/paths.test.py）。
const fs = require("fs");
const path = require("path");

const APP_DIR_NAME = "TeyvatMelody";

// 「这里是软件根目录」的标记：resources 下有 Electron 的 app.asar 或后端目录。
// 用标记而不是「目录名恰好叫 resources」—— 后者在用户把应用装进
// `D:\resources\TeyvatMelody` 这类路径时会向上误判到 `D:\`。
const ROOT_MARKERS = ["app.asar", "app", "backend"];

/**
 * 定位软件根目录（安装目录）。
 *
 * 入参可以是**安装树里的任意一个可执行文件** —— 主进程是 `<根>/TeyvatMelody.exe`，
 * 后端是 `<根>/resources/backend/TeyvatBackend/TeyvatBackend.exe`，
 * 两种都能正确上溯到 `<根>`（与后端 `app/utils/paths.py` 的 `_install_dir` 语义一致）。
 */
function installDir(exePath) {
  let cur = path.resolve(exePath, "..");
  const start = cur;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    const res = path.join(cur, "resources");
    if (ROOT_MARKERS.some((m) => fs.existsSync(path.join(res, m)))) return cur;
    cur = parent;
  }
  return start;
}

/** 该目录是否为「安装版」（存在 `Uninstall *.exe`） */
function isInstalledBuild(dir) {
  try {
    return fs.readdirSync(dir).some((n) => /^Uninstall .+\.exe$/i.test(n));
  } catch {
    return false; // 目录不可读 → 当作免安装版（退回安装目录，至少不会找不到数据）
  }
}

/**
 * 决定数据根目录。
 * @param {{isDev: boolean, exePath: string, localAppData?: string, projectRoot: string}} o
 */
function resolveDataRoot({ isDev, exePath, localAppData, projectRoot }) {
  if (isDev) return projectRoot;
  const dir = installDir(exePath);
  if (isInstalledBuild(dir)) {
    // 拿不到 LOCALAPPDATA（非 Windows / 异常环境）就退回安装目录本身 ——
    // 注意不能再套一层 TeyvatMelody 子目录：那样数据仍在安装目录内，升级照样被删，
    // 只是多了一层让人困惑的嵌套。这里退化为「老行为」，至少能正常用。
    return localAppData ? path.join(localAppData, APP_DIR_NAME) : dir;
  }
  return dir;
}

/** 老版本（≤1.0.5）把数据放在安装目录里，升级后需要搬到新位置 */
const LEGACY_DATA_DIRS = ["data", "music", "sources", "cache", ".appdata"];

module.exports = { APP_DIR_NAME, LEGACY_DATA_DIRS, installDir, isInstalledBuild, resolveDataRoot };
