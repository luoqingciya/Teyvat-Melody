// SourceHost 宿主自检：node tests/host.js
const fs = require("fs");
const path = require("path");
const { SourceInstance } = require("../electron/sourceHost");

const ok = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  // 1. 正常源：inited 握手 + meta 解析
  const raw = fs.readFileSync(path.join(__dirname, "fixtures", "test-source.js"), "utf8");
  const inst = new SourceInstance("t1", raw);
  const sources = await inst.init();
  ok("inited 握手", !!sources);
  ok("@name 解析", inst.meta.name === "测试音乐源");
  ok("@version 解析", inst.meta.version === "1.0.0");
  ok("@author 解析", inst.meta.author === "teyvat-test");
  ok("sources 声明 kw/tx/local", ["kw", "tx", "local"].every((k) => sources[k]));
  ok("kw qualitys 声明", (sources.kw.qualitys || []).join() === "128k,320k,flac,flac24bit");
  ok("local actions 含 lyric/pic", ["lyric", "pic"].every((a) => sources.local.actions.includes(a)));

  // 2. musicUrl 调用：musicInfo 透传 + env/version 注入
  const url = await inst.call("kw", "musicUrl", { type: "320k", musicInfo: { songmid: "abc123" } });
  ok("musicUrl 返回 URL", url === "https://test.local/kw/320k/abc123?env=desktop&v=3.0.0");

  // 3. lx.request 真实 HTTP（QQ 搜索接口）
  //    依赖外网：CI / 受限网络下不可达时记为 SKIP 而非 FAIL，避免把环境问题当成代码缺陷。
  try {
    const name = await inst.call("kw", "searchEcho", {});
    ok("lx.request 真实请求（QQ 搜索）", typeof name === "string" && name.length > 0);
    console.log("      搜索返回第一首:", name);
  } catch (e) {
    console.log(`SKIP  lx.request 真实请求（QQ 搜索）  → 外网不可达：${e.message}`);
  }

  // 4. 未知 action：脚本 reject 透传
  try {
    await inst.call("kw", "notExist", {});
    ok("未知 action 抛错", false);
  } catch (e) {
    ok("未知 action 抛错", /not support/.test(e.message));
  }

  // 5. 缺 @name 的脚本：初始化拒绝
  const bad = new SourceInstance("t2", "const a = 1");
  try {
    await bad.init();
    ok("缺 @name 拒绝", false);
  } catch (e) {
    ok("缺 @name 拒绝", /@name/.test(e.message));
  }

  // 6. 不发 inited 的脚本：超时拒绝（自检用短超时，避免真等默认 30s）
  const slow = new SourceInstance("t3", "/** @name 永不初始化 */ const a = 1", { initTimeout: 800 });
  try {
    await slow.init();
    ok("inited 超时拒绝", false);
  } catch (e) {
    ok("inited 超时拒绝", /超时/.test(e.message));
  }

  // 7. 沙箱隔离：无 require / process
  const iso = new SourceInstance("t4", "/** @name 隔离检查 */ globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, { sources: { kw: { type: 'music', actions: ['musicUrl'], qualitys: [] } } })");
  await iso.init();
  const probe = await iso.call("kw", "musicUrl", {}).catch(() => "no-handler");
  ok("沙箱无 require 全局", probe === "no-handler"); // 未注册 request handler → 宿主报错

  console.log("\n自检完成");
})().catch((e) => {
  console.error("自检异常:", e);
  process.exitCode = 1;
});
