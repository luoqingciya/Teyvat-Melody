// 数据根目录选址自检：node tests/data-root.test.js
//
// 背景：安装版升级时，NSIS 安装器会先跑旧版卸载程序，而它会 `RMDir /r $INSTDIR`。
// 数据若放在安装目录里就会**每次更新都丢光**。所以这里锁死「安装版数据放
// %LOCALAPPDATA%\TeyvatMelody、免安装版放安装目录」这条规则。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { APP_DIR_NAME, LEGACY_DATA_DIRS, installDir, isInstalledBuild, resolveDataRoot } = require("../electron/dataRoot");

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

ok("installDir：取 exe 所在目录", installDir(portable.backendExe) === portable.exeDir, installDir(portable.backendExe));
ok("安装版判定：有 Uninstall *.exe → true", isInstalledBuild(installed.exeDir) === true);
ok("免安装版判定：没有卸载程序 → false", isInstalledBuild(portable.exeDir) === false);
ok("安装版判定：目录不存在时不抛错", isInstalledBuild(path.join(portable.tmp, "nope")) === false);

ok(
  "开发模式：数据根目录 = 项目根目录",
  resolveDataRoot({ isDev: true, exePath: portable.backendExe, projectRoot: "/proj" }) === "/proj"
);
ok(
  "免安装版：数据根目录 = 安装目录（整个文件夹可搬移）",
  resolveDataRoot({ isDev: false, exePath: portable.backendExe, localAppData: fakeLocal, projectRoot: "/proj" }) ===
    portable.exeDir
);
ok(
  "安装版：数据根目录 = %LOCALAPPDATA%/TeyvatMelody（升级卸载都不碰）",
  resolveDataRoot({ isDev: false, exePath: installed.backendExe, localAppData: fakeLocal, projectRoot: "/proj" }) ===
    path.join(fakeLocal, APP_DIR_NAME)
);
ok(
  "安装版：拿不到 LOCALAPPDATA 时退回安装目录（不崩、也能找到数据）",
  resolveDataRoot({ isDev: false, exePath: installed.backendExe, localAppData: undefined, projectRoot: "/proj" }) ===
    installed.exeDir
);
ok(
  "安装版的数据目录一定不在安装目录内（这正是防丢数据的关键）",
  !resolveDataRoot({ isDev: false, exePath: installed.backendExe, localAppData: fakeLocal, projectRoot: "/proj" }).startsWith(
    installed.exeDir
  )
);

ok(
  "需要迁移的历史数据目录齐全（data/music/sources/cache/.appdata）",
  ["data", "music", "sources", "cache", ".appdata"].every((d) => LEGACY_DATA_DIRS.includes(d)),
  JSON.stringify(LEGACY_DATA_DIRS)
);

fs.rmSync(portable.tmp, { recursive: true, force: true });
fs.rmSync(installed.tmp, { recursive: true, force: true });

console.log("\n自检结束");
