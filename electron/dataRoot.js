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

/**
 * 把老位置里的数据搬到当前数据根目录（只在根目录还没有数据时执行）。
 *
 * ⚠️ 这是**用户升级后不丢数据的最后一道保险** —— 一旦写错，老用户看到的就是
 * 「曲库、歌单、收藏全空了」。所以这条逻辑放在这里（纯函数、可单测），
 * 而不是埋在 main.js 里（main.js 依赖 Electron，测不了）。
 *
 * 关键取舍：
 *   · **只在目标没有数据时才搬**（根目录已有 `data/` 就完全不动），
 *     否则重装/二次启动会把用户的新数据覆盖回旧快照。
 *   · **先试 `renameSync`（同盘瞬间完成、不占双份空间）**：这是主路径，
 *     语义上等于「移动」，搬完老位置就没了 —— 同盘 rename 不会中途失败，
 *     所以不存在「搬一半」的风险，这一步是安全的。
 *   · rename 失败（跨盘符：装在 D:、老数据在 C: 是常见情况）则退回
 *     `cpSync` **复制**（`force:false` 是合并语义，不覆盖目标已有文件）：
 *     这条路径下老数据会保留一份，占双份空间，用户确认无误后可自行删掉旧目录。
 *   · 总效果：**同盘=移动、跨盘=复制**。老数据会不会留一份，取决于两个盘是不是同一个。
 *   · 单个目录失败不影响其它目录（各自 try/catch），能救几个是几个 ——
 *     真正的失败场景是目标写不进去（盘满、权限、文件占用），不是「目标已有同名目录」
 *     （那个走 cpSync 合并，会成功）。
 *
 * @param {string} newRoot 目标数据根目录
 * @param {Array<string|null|undefined>} legacyRoots 候选旧位置，按优先级排列
 * @returns {string[]} 实际搬过来的目录名（空数组表示没搬任何东西）
 */
function migrateLegacyData(newRoot, legacyRoots) {
  if (fs.existsSync(path.join(newRoot, "data"))) return []; // 已有数据 → 不动，避免覆盖
  for (const legacyRoot of legacyRoots) {
    if (!legacyRoot || path.resolve(newRoot) === path.resolve(legacyRoot)) continue;
    if (!fs.existsSync(path.join(legacyRoot, "data"))) continue;
    const moved = [];
    for (const name of DATA_DIRS) {
      const from = path.join(legacyRoot, name);
      if (!fs.existsSync(from)) continue;
      const to = path.join(newRoot, name);
      try {
        fs.mkdirSync(newRoot, { recursive: true });
        try {
          fs.renameSync(from, to); // 同盘：瞬间完成
        } catch {
          // 跨盘符 rename 会失败（装在 D:、数据在 C: 时很常见）→ 退回复制
          fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
        }
        moved.push(name);
      } catch (e) {
        console.warn(`[migrate] 迁移 ${name} 失败：${e.message}`);
      }
    }
    if (moved.length) return moved;
  }
  return [];
}

module.exports = {
  APP_DIR_NAME,
  DATA_DIRS,
  ROOT_MARKERS,
  installDir,
  isInstalledBuild,
  resolveDataRoot,
  legacyLocalAppDataRoot,
  migrateLegacyData,
};
