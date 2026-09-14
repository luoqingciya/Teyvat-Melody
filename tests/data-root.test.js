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

fs.rmSync(portable.tmp, { recursive: true, force: true });
fs.rmSync(installed.tmp, { recursive: true, force: true });

console.log("\n自检结束");
