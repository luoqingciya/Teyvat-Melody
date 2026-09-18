// 在线更新检查自检：node tests/updater.test.js
//
// 覆盖版本比较、下载项筛选、以及与 GitHub API 交互的三种结果（有新版 / 已最新 / 失败）。
// 通过注入 fetchImpl 打桩，不依赖外网。
const {
  checkForUpdate,
  isNewer,
  pickAssets,
  pickAssetFor,
  installAction,
  installQuitDecision,
  SPAWN_GRACE_MS,
  SETTLE_MS,
  SPAWN_DEADLINE_MS,
} = require("../electron/updater");

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

/** 构造一个假的 fetch：返回给定的 Release JSON / 状态码 / 抛错 */
function fakeFetch({ status = 200, json = null, throws = null } = {}) {
  return async () => {
    if (throws) throw new Error(throws);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
}

const RELEASE = {
  tag_name: "v1.2.0",
  name: "v1.2.0",
  body: "## 更新内容\n- 修复了搜索",
  html_url: "https://github.com/luoqingciya/Teyvat-Melody/releases/tag/v1.2.0",
  published_at: "2026-10-01T10:00:00Z",
  assets: [
    { name: "TeyvatMelody-Setup-1.2.0.exe", browser_download_url: "https://github.com/x/a.exe", size: 100 },
    { name: "TeyvatMelody-1.2.0-x64.zip", browser_download_url: "https://github.com/x/a.zip", size: 200 },
    { name: "TeyvatMelody-1.2.0-x86_64.AppImage", browser_download_url: "https://github.com/x/a.AppImage", size: 300 },
    { name: "TeyvatMelody-1.2.0-x86_64.tar.gz", browser_download_url: "https://github.com/x/a.tar.gz", size: 400 },
    { name: "latest.yml", browser_download_url: "https://github.com/x/latest.yml", size: 1 },
  ],
};

(async () => {
  try {
    // ---- isNewer ----
    ok("1.0.1 > 1.0.0", isNewer("1.0.1", "1.0.0"));
    ok("1.1.0 > 1.0.9", isNewer("1.1.0", "1.0.9"));
    ok("2.0.0 > 1.9.9", isNewer("2.0.0", "1.9.9"));
    ok("同版本不算新", !isNewer("1.0.0", "1.0.0"));
    ok("旧版本不算新", !isNewer("0.9.9", "1.0.0"));
    ok("位数不同按 0 补齐（1.0 == 1.0.0）", !isNewer("1.0", "1.0.0") && !isNewer("1.0.0", "1.0"));
    ok("数字比较而非字典序（1.0.10 > 1.0.9）", isNewer("1.0.10", "1.0.9"));
    ok("带 v 前缀也能比", isNewer("v1.0.1", "1.0.0") && !isNewer("v1.0.0", "1.0.0"));
    // 空值解析为 0.0.0："" 不比任何正常版本新；反过来正常版本比 "" 新（不抛错即可）
    ok("空值不崩且不误判为更新", !isNewer("", "1.0.0") && isNewer("1.0.0", ""), `"" vs 1.0.0 = ${isNewer("", "1.0.0")}`);

    // ---- pickAssets ----
    const assets = pickAssets(RELEASE.assets);
    ok(
      "只保留可下载的产物（exe / zip / AppImage / tar.gz）",
      assets.length === 4 && assets.every((a) => /\.(exe|zip|appimage|tar\.gz)$/i.test(a.name)),
      JSON.stringify(assets.map((a) => a.name))
    );
    ok("⚠️ 不会漏掉 Linux 产物（否则 Linux 上挑不出可下载的包）",
       assets.some((a) => /\.appimage$/i.test(a.name)) && assets.some((a) => /\.tar\.gz$/i.test(a.name)),
       JSON.stringify(assets.map((a) => a.name)));
    ok("保留下载地址与大小", assets[0].url.includes("github.com") && assets[0].size === 100);
    ok("无 assets 时返回空数组", pickAssets(undefined).length === 0);

    // ---- pickAssetFor：按分发方式挑要下载的包 ----
    const both = pickAssets(RELEASE.assets);
    // ⚠️ 平台要显式传：不传就跟着跑测试的机器走，CI 在 ubuntu 上会得到 Linux 的结果
    const W = "win32";
    const L = "linux";
    ok("安装版优先 Setup exe（下完可直接拉起安装向导）", /\.exe$/i.test(pickAssetFor(both, true, W)?.name || ""), JSON.stringify(pickAssetFor(both, true, W)));
    ok("免安装版优先 zip（避免在系统里多装一份）", /\.zip$/i.test(pickAssetFor(both, false, W)?.name || ""), JSON.stringify(pickAssetFor(both, false, W)));
    ok("只有 exe 时免安装版也退回 exe", /\.exe$/i.test(pickAssetFor([{ name: "a-Setup-1.0.0.exe", url: "u", size: 1 }], false, W)?.name || ""));
    ok("只有 zip 时安装版也退回 zip", /\.zip$/i.test(pickAssetFor([{ name: "a.zip", url: "u", size: 1 }], true, W)?.name || ""));
    ok("无可用资产时返回 null", pickAssetFor([], true, W) === null && pickAssetFor(undefined, false, W) === null);

    // ---- Linux：只挑 AppImage / tar.gz，绝不挑到 Windows 的包 ----
    ok("⚠️ Linux 优先 AppImage", /\.appimage$/i.test(pickAssetFor(both, false, L)?.name || ""), JSON.stringify(pickAssetFor(both, false, L)));
    ok("⚠️ Linux 不会挑到 .exe（下载了也跑不起来）", !/\.exe$/i.test(pickAssetFor(both, true, L)?.name || ""), JSON.stringify(pickAssetFor(both, true, L)));
    ok("⚠️ Linux 不会挑到 .zip（那是 Windows 免安装包）", !/\.zip$/i.test(pickAssetFor(both, false, L)?.name || ""));
    ok("没有 AppImage 时退回 tar.gz", /\.tar\.gz$/i.test(pickAssetFor([{ name: "a-1.0.0-x86_64.tar.gz", url: "u", size: 1 }], false, L)?.name || ""));
    ok("Linux 上只有 Windows 包时返回 null（宁可不更新，也不下错平台）",
       pickAssetFor([{ name: "a-Setup-1.0.0.exe", url: "u", size: 1 }], true, L) === null);

    // ---- checkForUpdate：有新版 ----
    const up = await checkForUpdate("1.0.0", { fetchImpl: fakeFetch({ json: RELEASE }) });
    ok("有新版本时 hasUpdate=true", up.ok && up.hasUpdate && up.latest === "1.2.0", JSON.stringify(up));
    ok("带出当前版本 / 说明 / 页面地址", up.current === "1.0.0" && up.notes.includes("修复了搜索") && up.pageUrl.includes("/tag/v1.2.0"));
    ok("带出可下载资产（含 Linux 产物）", up.assets.length === 4, JSON.stringify(up.assets));

    // ---- 已是最新 ----
    const same = await checkForUpdate("1.2.0", { fetchImpl: fakeFetch({ json: RELEASE }) });
    ok("版本相同时 hasUpdate=false", same.ok && !same.hasUpdate && same.latest === "1.2.0", JSON.stringify(same));

    const newer = await checkForUpdate("1.3.0", { fetchImpl: fakeFetch({ json: RELEASE }) });
    ok("本地更新时不提示（不降级）", newer.ok && !newer.hasUpdate, JSON.stringify(newer));

    // ---- 失败分支：都不抛错，返回 ok=false ----
    const notFound = await checkForUpdate("1.0.0", { fetchImpl: fakeFetch({ status: 404 }) });
    ok("HTTP 404 → ok=false 且带状态码", !notFound.ok && /404/.test(notFound.message), JSON.stringify(notFound));

    const netErr = await checkForUpdate("1.0.0", { fetchImpl: fakeFetch({ throws: "ENOTFOUND" }) });
    ok("网络异常 → ok=false 且不抛错", !netErr.ok && /ENOTFOUND/.test(netErr.message), JSON.stringify(netErr));

    const noTag = await checkForUpdate("1.0.0", { fetchImpl: fakeFetch({ json: { assets: [] } }) });
    ok("缺 tag_name 时不误报有新版本", noTag.ok && !noTag.hasUpdate, JSON.stringify(noTag));

    // ---- 长发布说明被截断 ----
    const long = await checkForUpdate("1.0.0", {
      fetchImpl: fakeFetch({ json: { ...RELEASE, body: "x".repeat(20000) } }),
    });
    ok("超长发布说明被截断", long.notes.length <= 6000, `len=${long.notes.length}`);

    // ---- installAction：拉起更新包之后要不要退出应用 ----
    // 安装版下拉起的是 Setup exe：装的时候要替换 exe 与 resources/，当前进程占着句柄会
    // 让 NSIS 卡住/要求手动关，所以必须主动退出。
    const runPlan = installAction(false);
    ok("安装版：运行安装包", runPlan.action === "run", JSON.stringify(runPlan));
    ok("安装版：运行后要退出应用（否则安装程序替换不了正在被占用的文件）", runPlan.quitAfter === true, JSON.stringify(runPlan));
    // 免安装版只是定位 zip 让用户自己解压，这时候关掉应用反而莫名其妙。
    const revealPlan = installAction(true);
    ok("免安装版：只定位不运行", revealPlan.action === "reveal", JSON.stringify(revealPlan));
    ok("免安装版：绝不退出应用", revealPlan.quitAfter === false, JSON.stringify(revealPlan));

    // ---- installQuitDecision：拉起安装包之后**什么时候**退 ----
    // 真实缺陷：固定 1500ms 就退，但安装程序那时才刚起来（93MB 的 exe，画窗口要好几秒），
    // 于是「软件没关」被用户报回来。判据改成「等它稳定运行」。
    const st = (o) => ({ alive: true, elapsedMs: 0, hasWindow: true, seenWindow: true, ...o });

    ok(
      "刚拉起（安装程序还在起）→ 继续等，别急着退",
      installQuitDecision(st({ elapsedMs: 100, seenWindow: false })) === "wait",
      installQuitDecision(st({ elapsedMs: 100, seenWindow: false }))
    );
    ok(
      "超过宽限期就退（不再依赖一个固定延时要恰好落在窗口之间）",
      installQuitDecision(st({ elapsedMs: SPAWN_GRACE_MS - 1 })) === "wait" &&
        installQuitDecision(st({ elapsedMs: SPAWN_GRACE_MS + SETTLE_MS })) === "quit"
    );
    ok(
      "一直等不到窗口也有兜底（不能让用户干等）",
      installQuitDecision(st({ elapsedMs: SPAWN_DEADLINE_MS + 1, alive: true, hasWindow: false, seenWindow: false })) === "quit"
    );
    ok(
      "安装程序从未起来 → abort，别把用户晾在原地",
      installQuitDecision(st({ alive: false, seenWindow: false })) === "abort" &&
        installQuitDecision(st({ alive: false, seenWindow: false, elapsedMs: 3000 })) === "abort"
    );
    ok(
      "安装程序起来后又退出去了（用户已放弃/已完成）→ 该退，别再留在前台",
      installQuitDecision(st({ alive: false, seenWindow: true })) === "quit"
    );
  } catch (e) {
    console.log(`FAIL  自检异常中断  → ${e.message}`);
    process.exitCode = 1;
  } finally {
    console.log("\n自检结束");
  }
})();
