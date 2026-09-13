// 在线播放链路（音质降级 + 换源重试）自检：node tests/online.js
// 用两个假源覆盖：降级、偏好优先、全失败聚合、无源支持、禁用源后失效。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SourceManager } = require("../electron/sourceManager");

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

// 源 A：kw 平台，声明 128k/320k/flac；flac 故意失败，用于验证降级
const SRC_A = `
/**
 * @name 自检源A
 * @description 覆盖音质降级
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
const sources = {
  kw: { name: '酷我', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
}
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('action not support'))
  if (info.type === 'flac') return Promise.reject(new Error('flac 无版权'))
  return Promise.resolve('https://cdn.example.com/' + source + '/' + info.type + '.mp3')
})
send(EVENT_NAMES.inited, { status: true, openDevTools: false, sources })
`;

// 源 B：tx 平台，永远失败，用于验证错误聚合
const SRC_B = `
/**
 * @name 自检源B
 * @description 覆盖全失败
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
const sources = { tx: { name: 'QQ', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } }
on(EVENT_NAMES.request, () => Promise.reject(new Error('上游 403')))
send(EVENT_NAMES.inited, { status: true, openDevTools: false, sources })
`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tm-online-"));
  try {
    fs.mkdirSync(path.join(root, "sources"), { recursive: true });
    fs.writeFileSync(path.join(root, "sources", "a.js"), SRC_A);
    fs.writeFileSync(path.join(root, "sources", "b.js"), SRC_B);

    const mgr = new SourceManager(root);
    await mgr.init();

    const list = mgr.list();
    ok("两个源均加载成功", list.length === 2 && list.every((s) => !s.error), JSON.stringify(list.map((s) => s.error)));

    const cap = mgr.capabilitiesFor("kw");
    ok(
      "capabilitiesFor(kw) 汇总音质与 actions",
      cap.qualitys.sort().join(",") === "128k,320k,flac" && cap.actions.includes("musicUrl"),
      JSON.stringify(cap)
    );

    // 1) 降级：flac 失败 → 自动降档到 320k
    const r1 = await mgr.resolveMusicUrl("kw", { rid: "1" });
    ok("音质降级 flac→320k", r1.quality === "320k" && r1.url.endsWith("/320k.mp3"), JSON.stringify(r1));

    // 2) 偏好优先：preferred=128k 时排到链首
    const r2 = await mgr.resolveMusicUrl("kw", { rid: "1" }, "128k");
    ok("偏好音质优先(128k)", r2.quality === "128k", JSON.stringify(r2));

    // 3) 命中源信息回传（sourceName 为源脚本 @name，供后续 UI 展示"实际由哪个源提供"）
    ok("返回命中源 id 与脚本名", r1.sourceId === "a" && r1.sourceName === "自检源A", JSON.stringify(r1));

    // 4) 全部失败 → 抛错且聚合上游原因
    let err4 = null;
    try {
      await mgr.resolveMusicUrl("tx", { songmid: "x" });
    } catch (e) {
      err4 = e;
    }
    ok("全失败抛错并带上游原因", !!err4 && /403/.test(err4.message), err4 && err4.message);

    // 5) 无启用源支持该平台 → 明确报错
    let err5 = null;
    try {
      await mgr.resolveMusicUrl("wy", {});
    } catch (e) {
      err5 = e;
    }
    ok("无源支持平台时明确报错", !!err5 && /wy/.test(err5.message), err5 && err5.message);

    // 6) 禁用源后不再参与解析
    await mgr.toggle("a", false);
    let err6 = null;
    try {
      await mgr.resolveMusicUrl("kw", {});
    } catch (e) {
      err6 = e;
    }
    ok("禁用源后 kw 不可用", !!err6, err6 && err6.message);
  } catch (e) {
    console.log(`FAIL  自检异常中断  → ${e.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    console.log("\n自检结束");
  }
})();
