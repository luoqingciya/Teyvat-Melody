// 在线更新检查自检：node tests/updater.test.js
//
// 覆盖版本比较、下载项筛选、以及与 GitHub API 交互的三种结果（有新版 / 已最新 / 失败）。
// 通过注入 fetchImpl 打桩，不依赖外网。
const { checkForUpdate, isNewer, pickAssets } = require("../electron/updater");

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
    ok("只保留 exe / zip", assets.length === 2 && assets.every((a) => /\.(exe|zip)$/.test(a.name)), JSON.stringify(assets.map((a) => a.name)));
    ok("保留下载地址与大小", assets[0].url.includes("github.com") && assets[0].size === 100);
    ok("无 assets 时返回空数组", pickAssets(undefined).length === 0);

    // ---- checkForUpdate：有新版 ----
    const up = await checkForUpdate("1.0.0", { fetchImpl: fakeFetch({ json: RELEASE }) });
    ok("有新版本时 hasUpdate=true", up.ok && up.hasUpdate && up.latest === "1.2.0", JSON.stringify(up));
    ok("带出当前版本 / 说明 / 页面地址", up.current === "1.0.0" && up.notes.includes("修复了搜索") && up.pageUrl.includes("/tag/v1.2.0"));
    ok("带出可下载资产", up.assets.length === 2, JSON.stringify(up.assets));

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
  } catch (e) {
    console.log(`FAIL  自检异常中断  → ${e.message}`);
    process.exitCode = 1;
  } finally {
    console.log("\n自检结束");
  }
})();
