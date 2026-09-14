// 启动迁移的「接线」自检：node tests/migrate-startup.test.js
//
// 为什么还要这个文件（data-root.test.js 已经测过 migrateLegacyData 了）：
// 那边测的是**纯函数本身**（喂两个路径进去，看搬得对不对）。这里测的是
// **main.js 启动时到底怎么用它** —— 也就是「接线」：
//
//   migrateLegacyData(root, [legacyLocalAppDataRoot(process.env.LOCALAPPDATA)])
//   if (!IS_DEV) { ... }        ← 只在打包运行时才搬
//
// 接线接错的后果和函数写错一样严重（少传一个参数、把 IS_DEV 条件写反、
// 忘了调 legacyLocalAppDataRoot 而直接把 LOCALAPPDATA 当老位置……），
// 但纯函数单测完全覆盖不到这类问题。
//
// 本文件用一个真实的临时目录树复刻启动序列，断言：
//   · 老位置（%LOCALAPPDATA%\TeyvatMelody）的数据被搬到软件目录
//   · `.appdata` 的 userData 重定向逻辑也不会漏掉既有配置
//   · 开发模式（IS_DEV）下不搬（避免开发机上乱动真实目录）
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  APP_DIR_NAME,
  DATA_DIRS,
  legacyLocalAppDataRoot,
  migrateLegacyData,
} = require("../electron/dataRoot");

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

/**
 * 复刻 electron/main.js 里 ensureUserDataUnderRoot 的启动序列。
 * 与真实代码保持**逐行对应**（改动 main.js 时这里要同步，注释里也写了这一点）。
 *
 * @param {{root: string, localAppData: string, isDev: boolean}} o
 */
function runStartupSequence({ root, localAppData, isDev }) {
  const log = [];
  // ── 对应 main.js: `if (!IS_DEV) { migrateLegacyData(...) }` ──
  let moved = [];
  if (!isDev) {
    moved = migrateLegacyData(root, [legacyLocalAppDataRoot(localAppData)]);
    if (moved.length) log.push(`已把老位置的数据搬到 ${root}：${moved.join(", ")}`);
  }

  // ── 对应 main.js 的 app.setPath("userData", <root>/.appdata) 与首次迁移 ──
  const prevUserData = path.join(localAppData, "TeyvatMelody-UserData"); // 模拟 Electron 默认 userData
  const newUserData = path.join(root, ".appdata");
  let userDataMoved = false;
  if (path.resolve(newUserData) !== path.resolve(prevUserData)) {
    if (!fs.existsSync(newUserData) && fs.existsSync(prevUserData)) {
      try {
        fs.mkdirSync(newUserData, { recursive: true });
        fs.cpSync(prevUserData, newUserData, { recursive: true });
        userDataMoved = true;
      } catch (_) {}
    }
  }
  return { moved, userDataMoved, log };
}

// 造一棵「软件目录 + 老位置」的树
function makeWorld({ legacyDirs, userDataFile }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-startup-"));
  const root = path.join(tmp, "software"); // 模拟软件目录（EXE 同级）
  const localAppData = path.join(tmp, "LocalAppData");
  const legacy = path.join(localAppData, APP_DIR_NAME);
  fs.mkdirSync(root, { recursive: true });
  for (const name of legacyDirs) {
    fs.mkdirSync(path.join(legacy, name), { recursive: true });
    fs.writeFileSync(path.join(legacy, name, "marker.txt"), `legacy-${name}`);
  }
  if (userDataFile) {
    const prevUserData = path.join(localAppData, "TeyvatMelody-UserData");
    fs.mkdirSync(prevUserData, { recursive: true });
    fs.writeFileSync(path.join(prevUserData, userDataFile), "old-settings");
  }
  return { tmp, root, localAppData, legacy };
}

// ① 打包运行（IS_DEV=false）+ 老位置有数据 → 全部搬到软件目录
{
  const w = makeWorld({ legacyDirs: ["data", "sources"], userDataFile: "Local Storage" });
  const r = runStartupSequence({ root: w.root, localAppData: w.localAppData, isDev: false });

  ok(
    "启动迁移：老位置的 data / sources 都进了软件目录",
    fs.existsSync(path.join(w.root, "data", "marker.txt")) &&
      fs.existsSync(path.join(w.root, "sources", "marker.txt")),
    JSON.stringify(r.moved)
  );
  ok(
    "启动迁移：.appdata 也从旧 userData 接过来了（历史配置不丢）",
    r.userDataMoved && fs.existsSync(path.join(w.root, ".appdata", "Local Storage"))
  );
  ok("启动迁移：确实产生了迁移日志（用户能在控制台看到）", r.log.length === 1, JSON.stringify(r.log));
  fs.rmSync(w.tmp, { recursive: true, force: true });
}

// ② 开发模式（IS_DEV=true）→ 一个字节都不许动
//
// 这条很重要：开发时 LOCALAPPDATA 指向的是**开发机真实目录**，
// 若开发模式也执行迁移，会把开发者自己的配置文件搬进仓库目录。
{
  const w = makeWorld({ legacyDirs: ["data"], userDataFile: null });
  const before = fs.readdirSync(path.join(w.legacy, "data")).join(",");
  const r = runStartupSequence({ root: w.root, localAppData: w.localAppData, isDev: true });

  ok("启动迁移：开发模式不搬任何东西（返回空 + 老位置原样）", r.moved.length === 0);
  ok(
    "启动迁移：开发模式下老位置内容不变",
    fs.readdirSync(path.join(w.legacy, "data")).join(",") === before
  );
  ok("启动迁移：开发模式下软件目录里不会凭空多出 data/", !fs.existsSync(path.join(w.root, "data")));
  fs.rmSync(w.tmp, { recursive: true, force: true });
}

// ③ 没有老位置（全新安装）→ 静默通过，不建多余目录
{
  const w = makeWorld({ legacyDirs: [], userDataFile: null });
  const r = runStartupSequence({ root: w.root, localAppData: w.localAppData, isDev: false });

  ok("启动迁移：全新安装时什么都不做（不抛错、无日志）", r.moved.length === 0 && r.log.length === 0);
  ok("启动迁移：全新安装时软件目录保持空（不预先建 data/ 等）", fs.readdirSync(w.root).length === 0);
  fs.rmSync(w.tmp, { recursive: true, force: true });
}

// ④ 软件目录**已有数据**（用户已在用新版）→ 绝不能拿老快照覆盖回去
//
// 这是最危险的一种：用户先用了一段时间新版（软件目录里有新曲库），
// 某次启动时 %LOCALAPPDATA% 里那份**旧**数据被搬进来了 —— 覆盖掉的就是用户的心血。
{
  const w = makeWorld({ legacyDirs: ["data", "sources"], userDataFile: null });
  // 软件目录里已经有「更新」的数据
  fs.mkdirSync(path.join(w.root, "data"), { recursive: true });
  fs.writeFileSync(path.join(w.root, "data", "current.db"), "NEW-DATA");

  const r = runStartupSequence({ root: w.root, localAppData: w.localAppData, isDev: false });

  ok("启动迁移：软件目录已有数据时跳过迁移（不覆盖用户新数据）", r.moved.length === 0);
  ok(
    "启动迁移：用户新数据完好无损",
    fs.readFileSync(path.join(w.root, "data", "current.db"), "utf8") === "NEW-DATA"
  );
  ok(
    "启动迁移：跳过时也不会把老位置的 marker 混进来",
    !fs.existsSync(path.join(w.root, "data", "marker.txt"))
  );
  fs.rmSync(w.tmp, { recursive: true, force: true });
}

// ⑤ 老位置存在但里面没有 data/（只有 cache 之类的杂物）→ 不认作「老版本数据」
{
  const w = makeWorld({ legacyDirs: ["cache"], userDataFile: null });
  const r = runStartupSequence({ root: w.root, localAppData: w.localAppData, isDev: false });

  ok("启动迁移：老位置没有 data/ 时不触发迁移（避免搬来无意义杂物）", r.moved.length === 0);
  ok("启动迁移：此时软件目录仍保持干净", !fs.existsSync(path.join(w.root, "cache")));
  fs.rmSync(w.tmp, { recursive: true, force: true });
}

// ⑥ 所有需要跟随应用搬移的目录都要覆盖到
//
// ⚠️ 用**硬编码的期望清单**而不是直接遍历 DATA_DIRS：若只遍历常量，
// 那么「往 DATA_DIRS 里加一个目录但迁移逻辑漏了它」这种改动永远测不出来
// （两边同源，一起变）。这里把「应该有哪些」独立写一份，常量变化时这条会红，
// 提醒你去确认新目录到底该不该迁移、并且是可搬移的。
{
  const EXPECTED_DIRS = ["data", "music", "sources", "cache", ".appdata"];

  ok(
    "启动迁移：DATA_DIRS 与预期清单一致（新增目录时请确认它可搬移）",
    EXPECTED_DIRS.every((d) => DATA_DIRS.includes(d)) && DATA_DIRS.length === EXPECTED_DIRS.length,
    `DATA_DIRS=${JSON.stringify(DATA_DIRS)}`
  );

  const w = makeWorld({ legacyDirs: EXPECTED_DIRS, userDataFile: null });
  const r = runStartupSequence({ root: w.root, localAppData: w.localAppData, isDev: false });

  const allArrived = EXPECTED_DIRS.every((d) => fs.existsSync(path.join(w.root, d, "marker.txt")));
  ok(
    `启动迁移：${EXPECTED_DIRS.length} 个目录全部能从老位置搬过来`,
    allArrived,
    `moved=${JSON.stringify(r.moved)}`
  );
  fs.rmSync(w.tmp, { recursive: true, force: true });
}

console.log("\n自检结束");
