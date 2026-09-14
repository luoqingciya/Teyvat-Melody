// 数据根目录选址。
//
// **数据一律放在软件目录（EXE 同级）** —— 免安装版与安装版都一样，这样整个目录是
// 自包含的：可以整体搬移、复制、备份，卸载也只是删掉这一个目录。
//
// ⚠️ 但安装版有个陷阱必须知道：**升级时安装器会先执行旧版的卸载程序**
// （app-builder-lib/templates/nsis/installSection.nsh 的 uninstallOldVersion），
// 而它默认会 `RMDir /r $INSTDIR`（uninstaller.nsh）—— 把安装目录整个删掉，数据跟着没。
// 所以「数据放在安装目录里」这条约定**必须**配合 `resources/installer.nsh` 的
// `customRemoveFiles` 宏才能成立（升级时保留数据目录，真正卸载时才删）。
// 那段 NSIS 代码由 `tools/verify-nsis-keep-data.py` 用真实 makensis 编译验证 ——
// 改这里的选址逻辑、或改那个宏，都要把该脚本跑一遍。
//
// v1.0.6 曾把安装版的数据放在 %LOCALAPPDATA%\TeyvatMelody 以躲开卸载程序，
// 本版又改回软件目录，所以启动时要把那个旧位置的数据搬回来（见 main.js 的迁移逻辑）。
//
// ⚠️ 这套规则与后端 `app/utils/paths.py` 必须完全一致（两边各自要独立算数据目录），
// 改一处就要同步改另一处，并各自跑自检（tests/data-root.test.js / tests/paths.test.py）。
const fs = require("fs");
const path = require("path");

// 安装版的数据目录名。**仅用于识别 v1.0.6 的旧位置**。
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

/** 该目录是否为「安装版」（存在 `Uninstall *.exe`）。更新时据此选包，与数据位置无关。 */
function isInstalledBuild(dir) {
  try {
    return fs.readdirSync(dir).some((n) => /^Uninstall .+\.exe$/i.test(n));
  } catch {
    return false;
  }
}

/**
 * 决定数据根目录。
 * @param {{isDev: boolean, exePath: string, projectRoot: string}} o
 */
function resolveDataRoot({ isDev, exePath, projectRoot }) {
  if (isDev) return projectRoot;
  return installDir(exePath);
}

/** 需要随应用一起搬移 / 保留的数据目录 */
const DATA_DIRS = ["data", "music", "sources", "cache", ".appdata"];

/**
 * v1.0.6 的旧数据位置（那一版为了躲开卸载程序把安装版数据放在这里）。
 * 升级到本版后要把它搬回软件目录，否则老用户会「看起来数据没了」。
 */
function legacyLocalAppDataRoot(localAppData) {
  return localAppData ? path.join(localAppData, APP_DIR_NAME) : null;
}

module.exports = {
  APP_DIR_NAME,
  DATA_DIRS,
  ROOT_MARKERS,
  installDir,
  isInstalledBuild,
  resolveDataRoot,
  legacyLocalAppDataRoot,
};
