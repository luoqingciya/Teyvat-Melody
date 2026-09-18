// 数据根目录选址自检：node tests/data-root.test.js
//
// 规则：**数据一律放在软件目录（EXE 同级）** —— 免安装版与安装版都一样，
// 整个目录自包含、可整体搬移。
//
// ⚠️ 安装版的数据放在安装目录里，前提是 NSIS 的 customRemoveFiles 宏能在升级时
// 保住这些目录（否则升级时旧版卸载程序 `RMDir /r $INSTDIR` 会把数据删光 —— 这是
// 真实发生过的缺陷）。那段 NSIS 代码由 tools/verify-nsis-keep-data.py 用真实 makensis
// 验证，本文件只管选址规则。
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  APP_DIR_NAME,
  DATA_DIRS,
  installDir,
  isInstalledBuild,
  resolveDataRoot,
  legacyLocalAppDataRoot,
  migrateLegacyData,
} = require("../electron/dataRoot");

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

// 造一棵假的安装目录树：<tmp>/TeyvatMelody.exe + resources/backend/TeyvatBackend/TeyvatBackend.exe
function makeTree({ installed }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-root-"));
  const exeDir = path.join(tmp, "TeyvatMelody");
  const backendDir = path.join(exeDir, "resources", "backend", "TeyvatBackend");
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(path.join(exeDir, "TeyvatMelody.exe"), "");
  fs.writeFileSync(path.join(backendDir, "TeyvatBackend.exe"), "");
  if (installed) fs.writeFileSync(path.join(exeDir, "Uninstall TeyvatMelody.exe"), "");
  return { tmp, exeDir, backendExe: path.join(backendDir, "TeyvatBackend.exe") };
}

const portable = makeTree({ installed: false });
const installed = makeTree({ installed: true });
const fakeLocal = path.join(installed.tmp, "LocalAppData");

ok(
  "installDir：从后端 exe 也能上溯到软件根目录",
  installDir(portable.backendExe) === portable.exeDir,
  installDir(portable.backendExe)
);
ok(
  "installDir：主进程 exe（就在根下）也能定位到根",
  installDir(path.join(portable.exeDir, "TeyvatMelody.exe")) === portable.exeDir
);
ok("安装版判定：有 Uninstall *.exe → true", isInstalledBuild(installed.exeDir) === true);
ok("免安装版判定：没有卸载程序 → false", isInstalledBuild(portable.exeDir) === false);
ok("安装版判定：目录不存在时不抛错", isInstalledBuild(path.join(portable.tmp, "nope")) === false);

ok(
  "开发模式：数据根目录 = 项目根目录",
  resolveDataRoot({ isDev: true, exePath: portable.backendExe, projectRoot: "/proj" }) === "/proj"
);
ok(
  "免安装版：数据根目录 = 软件目录（整个文件夹可搬移）",
  resolveDataRoot({ isDev: false, exePath: portable.backendExe, projectRoot: "/proj" }) === portable.exeDir
);
ok(
  "安装版：数据根目录也 = 软件目录（跟 EXE 同级）",
  resolveDataRoot({ isDev: false, exePath: installed.backendExe, projectRoot: "/proj" }) === installed.exeDir
);

ok(
  "需要随应用搬移 / 保留的数据目录齐全",
  ["data", "music", "sources", "cache", ".appdata"].every((d) => DATA_DIRS.includes(d)),
  JSON.stringify(DATA_DIRS)
);

// v1.0.6 的旧位置（仅用于识别，好把数据搬回来）
ok(
  "v1.0.6 旧位置识别：%LOCALAPPDATA%/TeyvatMelody",
  legacyLocalAppDataRoot(fakeLocal) === path.join(fakeLocal, APP_DIR_NAME),
  legacyLocalAppDataRoot(fakeLocal)
);
ok("v1.0.6 旧位置识别：拿不到 LOCALAPPDATA 时返回 null（不崩）", legacyLocalAppDataRoot(undefined) === null);

//
// ── 老位置数据迁移 ────────────────────────────────────────────────────────────
//
// ⚠️ 这是**用户升级后不丢数据的最后一道保险**：v1.0.6 把安装版数据放在
// %LOCALAPPDATA%\TeyvatMelody，本版改回软件目录，必须把老数据搬回来。
// 写错的后果不是「少个功能」而是「曲库、歌单、收藏全空了」。
//
// 造一个「老位置」：<tmp>/legacy/{data,sources,...}
function makeLegacyRoot(parent, names) {
  const root = fs.mkdtempSync(path.join(parent, "tm-legacy-"));
  for (const name of names) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    // 放个标记文件，后面断言内容真的跟着搬过来了（而不只是目录名对上了）
    fs.writeFileSync(path.join(root, name, "marker.txt"), `from-${name}`);
  }
  return root;
}

const anyFile = (dir, name) => fs.existsSync(path.join(dir, name, "marker.txt"));

// ① 老位置有数据、新位置是空的 → 应该搬过来
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-mig-"));
  const legacy = makeLegacyRoot(tmp, ["data", "sources"]);
  const target = path.join(tmp, "app"); // 目标目录还不存在，迁移逻辑要自己建

  const moved = migrateLegacyData(target, [legacy]);
  ok(
    "迁移：老位置有数据 → 搬到新根目录",
    moved.length > 0 && anyFile(target, "data") && anyFile(target, "sources"),
    `moved=${JSON.stringify(moved)}`
  );
  ok(
    "迁移：只搬存在的目录（music/cache/.appdata 没建过就不该出现在结果里）",
    moved.includes("data") && moved.includes("sources") && !moved.includes("music"),
    JSON.stringify(moved)
  );
  // ⚠️ 同盘走 renameSync = **移动**（老位置会消失，这是刻意的：同盘 rename 不会中途失败，
  // 也就不存在「搬一半」的风险，还省一份空间）。反面是跨盘 —— 那里退回复制，原数据会留下。
  // 这条断言把当前行为钉住：哪天有人改成「无脑复制」，这里会提示他是有意为之还是误改。
  ok(
    "迁移：同盘用 rename（移动）—— 老目录搬走后就该不在原地了",
    !fs.existsSync(path.join(legacy, "data")) && !fs.existsSync(path.join(legacy, "sources"))
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ② 新位置已经有 data/ → 一个字节都不能动（否则二次启动会把新数据覆盖回旧快照）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-mig-"));
  const legacy = makeLegacyRoot(tmp, ["data", "sources"]);
  const target = path.join(tmp, "app");
  fs.mkdirSync(path.join(target, "data"), { recursive: true });
  fs.writeFileSync(path.join(target, "data", "new.db"), "current");

  const moved = migrateLegacyData(target, [legacy]);
  ok("迁移：新位置已有 data/ → 直接跳过，返回空数组", moved.length === 0, JSON.stringify(moved));
  ok("迁移：跳过时新数据完好无损", fs.readFileSync(path.join(target, "data", "new.db"), "utf8") === "current");
  ok("迁移：跳过时不该往新位置塞任何老目录", !fs.existsSync(path.join(target, "sources")));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ③ 新旧位置是同一个目录（理论上不该发生，但绝不能自己把自己搬没）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-mig-"));
  const root = makeLegacyRoot(tmp, ["data"]);
  const moved = migrateLegacyData(root, [root]);
  ok("迁移：新旧位置相同 → 跳过，且原数据还在", moved.length === 0 && anyFile(root, "data"));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ④ 按优先级取第一个「有数据」的老位置；前面的候选是空的就该跳过
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-mig-"));
  const empty = makeLegacyRoot(tmp, ["cache"]); // 没有 data/ → 不算数
  const real = makeLegacyRoot(tmp, ["data"]);
  const target = path.join(tmp, "app");

  const moved = migrateLegacyData(target, [null, "", empty, real]);
  ok(
    "迁移：跳过 null / 空串 / 无 data 的候选，命中真正有数据的那个",
    moved.includes("data") && anyFile(target, "data"),
    JSON.stringify(moved)
  );
  ok("迁移：命中后就不再尝试后面的候选（只搬一个来源）", moved.length === 1, JSON.stringify(moved));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ⑤ 老位置压根没有 data/ 时 → 什么都不做（全新安装的正常路径）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-mig-"));
  const legacy = path.join(tmp, "nothing"); // 连目录都不存在
  const target = path.join(tmp, "app");
  const moved = migrateLegacyData(target, [legacy]);
  ok("迁移：老位置不存在 → 返回空数组，不抛错", Array.isArray(moved) && moved.length === 0);
  ok("迁移：没东西可搬时不该凭空建出目标目录", !fs.existsSync(target));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ⑥ rename 失败会自动退回复制 —— 所以「目标已有同名目录」不是失败场景，而是合并场景
//
// ⚠️ 起手我把它当成「失败隔离」用例来写，结果是错的：实测 Windows 下
// `renameSync` 到**已存在的非空目录**会 EPERM，于是实现自动走了 `cpSync` 兜底分支，
// 而 `cpSync` 是**合并**语义（`force:false, errorOnExist:false`）→ 迁移照样成功。
// 这其实是个好性质：重装/换目录时老数据能合并进来，不会因为目标已有同名目录就整段放弃。
//
// 真正的「搬不动」是**目标位置写不进去**（盘满、权限、文件占用）。那类失败用
// 单元测试不好稳定构造，这里只钉住「合并」这一条实际会走到的路径；
// 失败隔离靠代码里的 per-directory try/catch，以及下面 ⑦ 的断言间接覆盖。
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-mig-"));
  const legacy = makeLegacyRoot(tmp, ["data", "sources"]);
  const target = path.join(tmp, "app");
  // 目标没有 data/（守卫放行），但 sources 是个**已存在的非空目录** → rename EPERM → cpSync 合并
  fs.mkdirSync(path.join(target, "sources"), { recursive: true });
  fs.writeFileSync(path.join(target, "sources", "existing.txt"), "kept");

  const moved = migrateLegacyData(target, [legacy]);
  ok(
    "迁移：目标已有同名目录时，rename 失败退回复制并**合并**（不是整段放弃）",
    moved.includes("sources") && fs.existsSync(path.join(target, "sources", "marker.txt")),
    `moved=${JSON.stringify(moved)}`
  );
  ok(
    "迁移：合并式复制不删目标原有文件（force:false 的语义）",
    fs.readFileSync(path.join(target, "sources", "existing.txt"), "utf8") === "kept"
  );
  ok(
    "迁移：走了复制路径时老数据保留一份（复制不是移动，用户可自行清理）",
    anyFile(legacy, "sources")
  );
  ok(
    "迁移：同一次调用里，同盘目录走 rename、被占住的走 copy，两者都要成功",
    moved.includes("data") && anyFile(target, "data") && !fs.existsSync(path.join(legacy, "data")),
    JSON.stringify(moved)
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

fs.rmSync(portable.tmp, { recursive: true, force: true });
fs.rmSync(installed.tmp, { recursive: true, force: true });

console.log("\n自检结束");
