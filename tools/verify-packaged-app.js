// 验证**打包后**（真实 Electron 主进程）的数据目录选址：node tools/verify-packaged-app.js
//
// 为什么需要这个脚本：数据目录选址规则有两套实现 —— Electron 主进程（electron/dataRoot.js）
// 与后端（app/utils/paths.py）。后端的打包路径已由 tools/verify-frozen-paths.py 验证；
// 而主进程这一侧此前只跑过单元测试（把 isDev/exePath/LOCALAPPDATA 当参数注入），
// 真正打包运行时才会走到的 `app.isPackaged` / `process.execPath` / 环境变量读取从没被执行过。
//
// 主进程这一侧算错的后果与后端一样严重：`.appdata`（设置）与 `sources/`（自定义源）
// 会落回安装目录 —— 升级时被卸载程序删光。
//
// 分两段，第一段不需要打包就能跑：
//   ① 布局校验：在**真实打包布局**上验证 installDir / isInstalledBuild / resolveDataRoot。
//      规则对不对，取决于真实产物里 resources/app.asar 与 Uninstall *.exe 的位置 ——
//      这正是单元测试（自造假目录树）覆盖不到的部分。
//   ② 实跑校验：把应用当「安装版」「免安装版」各启动一次，看数据实际落在哪。
//      需要先打包（见下），且用临时 LOCALAPPDATA，全程不碰真实用户目录。
//
// 用法：
//   node tools/verify-packaged-app.js                 # 只跑 ①（找得到真实布局的话）
//   npx electron-builder --dir --publish never        # 打包后才能跑 ②
//   node tools/verify-packaged-app.js <未压缩应用目录>
//
// ⚠️ 本机跑 electron-builder 很慢（实测 --dir 会卡在压缩阶段 20 分钟以上），
//    优先用 CI 的产物或直接看 ① 的结果。
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dataRootUtil = require("../electron/dataRoot");

const ROOT = path.join(__dirname, "..");
const APP_DIR = path.resolve(process.argv[2] || path.join(ROOT, "electron-dist", "win-unpacked"));
const EXE = path.join(APP_DIR, "TeyvatMelody.exe");
const FAKE_UNINSTALLER = path.join(APP_DIR, "Uninstall TeyvatMelody.exe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) failed = true;
};

/** 在真实打包布局上校验选址规则（不需要打包就能跑）。 */
function checkRealLayouts() {
  const candidates = [
    { name: "免安装版（electron-dist/TeyvatMelody-portable）", dir: path.join(ROOT, "electron-dist", "TeyvatMelody-portable"), installed: false },
    { name: "安装版（%LOCALAPPDATA%/Programs/TeyvatMelody）", dir: path.join(process.env.LOCALAPPDATA || "", "Programs", "TeyvatMelody"), installed: true },
    { name: "安装版（自定义安装目录）", dir: process.env.TEYVAT_INSTALLED_DIR || "", installed: true },
  ];
  let checked = 0;
  for (const c of candidates) {
    if (!c.dir || !fs.existsSync(path.join(c.dir, "TeyvatMelody.exe"))) continue;
    checked++;
    const exePath = path.join(c.dir, "TeyvatMelody.exe");
    const found = dataRootUtil.installDir(exePath);
    const installed = dataRootUtil.isInstalledBuild(found);
    const root = dataRootUtil.resolveDataRoot({
      isDev: false,
      exePath,
      localAppData: process.env.LOCALAPPDATA,
      projectRoot: "/proj",
    });
    ok(`${c.name}：安装目录识别正确`, path.resolve(found) === path.resolve(c.dir), found);
    ok(`${c.name}：安装版判定正确`, installed === c.installed, `期望 ${c.installed}，实际 ${installed}`);
    // 数据一律在软件目录（EXE 同级）—— 安装版也一样，靠 NSIS 的 customRemoveFiles 宏
    // 在升级时保住这些目录（见 resources/installer.nsh）
    ok(
      `${c.name}：数据根目录 = 软件目录本身（跟 EXE 同级）`,
      path.resolve(root) === path.resolve(c.dir),
      root
    );
    ok(
      `${c.name}：不落在 %LOCALAPPDATA%（v1.0.6 的旧做法已废弃）`,
      !root.startsWith(process.env.LOCALAPPDATA || "\u0000"),
      root
    );
  }
  if (!checked) {
    console.log("SKIP  本机没有可校验的真实打包布局（先打包一次，或用 TEYVAT_INSTALLED_DIR 指定安装目录）");
  }
  return checked;
}

/** 启动应用，等**全部**期望目录出现（或超时），然后关掉。
 *
 *  等齐再判定很关键：`.appdata` 出现得早（Electron 首次写 userData 时），
 *  而 `sources/` 要等 `app.whenReady()` 里的 `sourceManager.init()` 才建 ——
 *  只等 `.appdata` 就杀进程会误判成「sources 没落对地方」。
 *
 *  LOCALAPPDATA 与 APPDATA 都指向临时目录 —— 后者是 Electron 默认 userData 的位置，
 *  不改的话应用会把**真实用户目录**里的旧数据搬进临时目录，验证就不干净了。 */
async function launchAndWait(localAppData, expectPaths, timeoutMs = 90000) {
  const proc = spawn(EXE, [], {
    cwd: APP_DIR,
    env: { ...process.env, LOCALAPPDATA: localAppData, APPDATA: path.join(localAppData, "..", "roaming") },
    stdio: "ignore",
  });
  const deadline = Date.now() + timeoutMs;
  const missing = () => expectPaths.filter((p) => !fs.existsSync(p));
  while (Date.now() < deadline) {
    if (!missing().length) {
      await sleep(800); // 目录出现后再等一拍，让同级目录也落定
      break;
    }
    if (proc.exitCode !== null) break; // 进程提前退出
    await sleep(500);
  }
  const left = missing();
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once("exit", resolve);
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, 8000);
  });
  return { seen: left.length === 0, missing: left, exitCode: proc.exitCode };
}

(async () => {
  // ① 布局校验：不需要打包
  console.log("=== ① 真实打包布局上的选址规则 ===");
  checkRealLayouts();

  // ② 实跑校验：需要打包产物
  console.log("\n=== ② 实跑校验（需要打包产物）===");
  if (!fs.existsSync(EXE)) {
    console.log(`SKIP  未找到打包后的应用：${EXE}`);
    console.log("      先执行：npx electron-builder --dir --publish never");
    console.log("\n验证结束");
    process.exit(failed ? 1 : 0);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-packaged-"));

  try {
    // ---- 情形一：安装版（同级有 Uninstall *.exe）----
    // 数据同样放在软件目录（EXE 同级）；升级时靠 NSIS 的 customRemoveFiles 宏保住。
    ok("前置：应用目录里此刻没有 .appdata（免安装版遗留）", !fs.existsSync(path.join(APP_DIR, ".appdata")));
    fs.writeFileSync(FAKE_UNINSTALLER, "");
    const instLocal = path.join(tmp, "installed-localappdata");
    const r1 = await launchAndWait(instLocal, [
      path.join(APP_DIR, ".appdata"),
      path.join(APP_DIR, "data"),
      path.join(APP_DIR, "sources"),
    ]);
    console.log(`  （安装版启动：见齐目录=${r1.seen} 缺=${JSON.stringify(r1.missing)} 退出码=${r1.exitCode}）`);
    ok("安装版：.appdata / data / sources 都落在软件目录（EXE 同级）", r1.seen, JSON.stringify(r1.missing));
    ok(
      "安装版：不往 %LOCALAPPDATA% 写数据（v1.0.6 的旧做法已废弃）",
      !fs.existsSync(path.join(instLocal, "TeyvatMelody")),
      path.join(instLocal, "TeyvatMelody")
    );

    // 撤掉假的卸载程序，切回免安装版形态
    fs.rmSync(FAKE_UNINSTALLER, { force: true });
    ok("前置：假卸载程序已移除", !fs.existsSync(FAKE_UNINSTALLER));

    // ---- 情形二：免安装版（没有卸载程序）→ 数据同样在软件目录 ----
    const portLocal = path.join(tmp, "portable-localappdata");
    const r2 = await launchAndWait(portLocal, [
      path.join(APP_DIR, ".appdata"),
      path.join(APP_DIR, "data"),
      path.join(APP_DIR, "sources"),
    ]);
    console.log(`  （免安装版启动：见齐目录=${r2.seen} 缺=${JSON.stringify(r2.missing)} 退出码=${r2.exitCode}）`);
    ok("免安装版：.appdata / data / sources 都落在软件目录（整目录可搬移）", r2.seen, JSON.stringify(r2.missing));
    ok(
      "免安装版：不往 LOCALAPPDATA 写东西",
      !fs.existsSync(path.join(portLocal, "TeyvatMelody")),
      path.join(portLocal, "TeyvatMelody")
    );
  } catch (e) {
    console.log(`FAIL  验证中断  → ${e.message}`);
    failed = true;
  } finally {
    try {
      fs.rmSync(FAKE_UNINSTALLER, { force: true });
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("\n验证结束");
  process.exit(failed ? 1 : 0);
})();
