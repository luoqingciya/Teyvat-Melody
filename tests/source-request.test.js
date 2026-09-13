// lx.request 兼容性与健壮性自检：node tests/request.js
//
// 覆盖两个已修复的真实缺陷：
// 1) 响应体解析若只看 Content-Type，会把「JSON 文本但标了 application/octet-stream」的响应当二进制，
//    源脚本拿到 Buffer 而非对象，取值失败（实测某源后端即如此，报"服务器异常"）。
// 2) 源脚本在 request 回调里抛错会沿事件回调冒泡成未捕获异常，把主进程打崩。
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SourceInstance, parseBody } = require("../electron/sourceHost");

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

const ROUTES = {
  "/json-octet": { ct: "application/octet-stream", body: '{"code":0,"musicUrl":"http://x/y.mp3"}' },
  "/json-xjs": { ct: "application/x-javascript", body: '{"code":0,"s":"kw|128k"}' },
  "/json-plain": { ct: "text/plain", body: '{"code":1,"msg":"boom"}' },
  "/json-none": { ct: "", body: '{"code":0}' },
  "/binary": { ct: "image/png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  "/text": { ct: "text/plain", body: "hello world" },
};

const server = http.createServer((req, res) => {
  const r = ROUTES[req.url] || { ct: "text/plain", body: "404" };
  res.writeHead(r.body === "404" ? 404 : 200, { "Content-Type": r.ct });
  res.end(r.body);
});

/** 生成一个临时源脚本；assertBody 决定它是否 inited（不 inited 则加载失败 → 断言失败） */
function makeSource(port, assertBody) {
  return `
/**
 * @name 请求自检源
 * @description lx.request 兼容性自检
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send, request } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.resolve('ok'))
request('http://127.0.0.1:${port}/json-octet', { method: 'GET' }, (err, resp) => {
  ${assertBody}
  send(EVENT_NAMES.inited, {
    sources: { kw: { name: '自检', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
  })
})
`;
}

async function loadSource(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tm-req-"));
  fs.mkdirSync(path.join(root, "sources"), { recursive: true });
  fs.writeFileSync(path.join(root, "sources", "t.js"), script, "utf8");
  const inst = new SourceInstance("t", script);
  try {
    await inst.init();
    return { inst, error: null, root };
  } catch (e) {
    return { inst, error: e, root };
  }
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    // ---- parseBody 单元：以内容判定，不被非标 Content-Type 误导 ----
    const b1 = parseBody(Buffer.from(ROUTES["/json-octet"].body), "application/octet-stream");
    ok("JSON 文本 + octet-stream → 解析为对象", b1 && b1.code === 0, JSON.stringify(b1));

    const b2 = parseBody(Buffer.from(ROUTES["/json-xjs"].body), "application/x-javascript");
    ok("JSON 文本 + x-javascript → 解析为对象", b2 && b2.s === "kw|128k", JSON.stringify(b2));

    const b3 = parseBody(Buffer.from(ROUTES["/json-none"].body), "");
    ok("JSON 文本 + 无 Content-Type → 解析为对象", b3 && b3.code === 0, JSON.stringify(b3));

    const b4 = parseBody(ROUTES["/binary"].body, "image/png");
    ok("真二进制 + image/png → 保持 Buffer", Buffer.isBuffer(b4), typeof b4);

    const b5 = parseBody(Buffer.from(ROUTES["/text"].body), "text/plain");
    ok("非 JSON 文本 → 字符串", b5 === "hello world", JSON.stringify(b5));

    // ---- 集成：走真实 lx.request（本地服务器返回 JSON 但标 octet-stream） ----
    const good = await loadSource(
      makeSource(port, "if (err || !resp.body || typeof resp.body !== 'object' || resp.body.code !== 0) return")
    );
    ok(
      "集成：octet-stream 伪装的 JSON 能被源正确取到（inited 成功）",
      !good.error,
      good.error && good.error.message
    );
    ok("集成：源声明平台可见", !good.error && !!good.inst.sources?.kw, JSON.stringify(good.inst.sources));
    fs.rmSync(good.root, { recursive: true, force: true });

    // ---- 健壮性：源在回调里抛错不得打崩宿主 ----
    let crashed = false;
    process.once("uncaughtException", () => {
      crashed = true;
    });
    const bad = await loadSource(makeSource(port, "throw new Error('源自己炸了')"));
    ok("源回调抛错时 init 失败但不崩溃", !!bad.error && !crashed, bad.error && bad.error.message);
    fs.rmSync(bad.root, { recursive: true, force: true });
  } catch (e) {
    console.log(`FAIL  自检异常中断  → ${e.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
    console.log("\n自检结束");
  }
})();
