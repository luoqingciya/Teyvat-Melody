// 自检：重定向跟随（node tests/http-redirect.test.js）
//
// 背景：项目零运行时依赖，所有对外请求都是手写的 http/https 调用，而手写请求最容易
// 漏掉的就是**跟随重定向**。实测踩到的坑：GitHub 的 Release 资产下载地址会
//   github.com/…/releases/download/vX/xxx.exe --302--> release-assets.githubusercontent.com
// 不跟就只会看到「HTTP 302」，而且**开不开代理都一样** —— 用户很容易误以为是代理没配好。
//
// 这里用本地服务器造重定向，不依赖外网（测试套件必须能离线跑）。
const http = require("http");
const { redirectTarget, MAX_REDIRECTS } = require("../electron/httpRedirect");
const { httpGetStream } = require("../electron/httpStream");

let FAILED = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (!cond && extra ? `  → ${extra}` : ""));
  if (!cond) FAILED = 1;
}

/** 把 httpGetStream 的流读完，返回 { status, body } */
function drain(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.stream.on("data", (c) => chunks.push(c));
    res.stream.on("end", () => resolve({ status: res.status, body: Buffer.concat(chunks).toString("utf8") }));
    res.stream.on("error", reject);
  });
}

/**
 * 分两段、间隔 30ms 返回 "hello"。
 *
 * ⚠️ 不能一次 `res.end("hello")`：那样响应体会在 `await httpGetStream()` 的续体跑起来之前
 * 就整个交付完（`complete` 已是 true），调用方再挂 'data' 监听就什么都收不到 —— 那是**测试写法**
 * 的问题，不是产品的问题（真实下载是 90MB，一直在流）。所以这里让它真的「流」起来。
 */
function sendSlow(res, body) {
  res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": body.length });
  res.write(body.slice(0, 2));
  setTimeout(() => res.end(body.slice(2)), 30);
}

async function main() {
  console.log("---- redirectTarget（纯函数）----");
  ok("302 + location → 跟", redirectTarget(302, "/b", "http://x/a") === "http://x/b");
  ok("301 也跟", redirectTarget(301, "http://y/z", "http://x/a") === "http://y/z");
  ok("303 也跟", !!redirectTarget(303, "/b", "http://x/a"));
  ok("307 也跟", !!redirectTarget(307, "/b", "http://x/a"));
  ok("308 也跟", !!redirectTarget(308, "/b", "http://x/a"));
  ok("200 不跟", redirectTarget(200, "/b", "http://x/a") === null);
  ok("404 不跟", redirectTarget(404, "/b", "http://x/a") === null);
  ok("3xx 但没有 location → 不跟（交给调用方按错误处理）", redirectTarget(302, "", "http://x/a") === null);
  ok("相对路径按 base 解析", redirectTarget(302, "b", "http://x/dir/a") === "http://x/dir/b");
  ok("协议相对 //host/p 也认", redirectTarget(302, "//y/p", "https://x/a") === "https://y/p");
  ok("⚠️ 拒绝 file:// （别被 location 骗去读本地文件）", redirectTarget(302, "file:///etc/passwd", "http://x/a") === null);
  ok("非法 location 不抛错，返回 null", redirectTarget(302, "http://[", "http://x/a") === null);
  ok("状态码是字符串时也认", redirectTarget("302", "/b", "http://x/a") === "http://x/b");

  console.log("\n---- httpGetStream 跟随重定向（本地服务器）----");
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/a") {
      res.writeHead(302, { Location: "/b" });
      return res.end();
    }
    if (req.url === "/rel") {
      res.writeHead(301, { Location: "b" });
      return res.end();
    }
    if (req.url === "/loop") {
      res.writeHead(302, { Location: "/loop" });
      return res.end();
    }
    if (req.url === "/noloc") {
      res.writeHead(302);
      return res.end();
    }
    if (req.url === "/b") {
      return sendSlow(res, "hello");
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // ① 302 → 200：这正是 GitHub 资产下载的形状
    {
      const res = await httpGetStream(`${base}/a`);
      const { status, body } = await drain(res);
      ok("⚠️ 302 被跟随，最终拿到 200（不再是「HTTP 302」）", status === 200, `status=${status}`);
      ok("跟随后的响应体正确", body === "hello", body);
    }

    // ② 相对 location
    {
      const res = await httpGetStream(`${base}/rel`);
      const { status, body } = await drain(res);
      ok("相对 location 也能跟到", status === 200 && body === "hello", `status=${status} body=${body}`);
    }

    // ③ 重定向环必须终止，不能永远挂着
    {
      let err = null;
      try {
        await httpGetStream(`${base}/loop`);
      } catch (e) {
        err = e;
      }
      ok("⚠️ 重定向环会被掐断（不会永远挂着）", !!err && /重定向次数过多/.test(err.message), err && err.message);
    }

    // ④ 3xx 但没有 location：不该死循环，也不该假装成功
    {
      const res = await httpGetStream(`${base}/noloc`);
      ok("3xx 无 location → 原样返回状态码（调用方自己判）", res.status === 302, `status=${res.status}`);
      res.cleanup();
    }

    // ⑤ 正常 200 不受影响
    {
      const res = await httpGetStream(`${base}/b`);
      const { status, body } = await drain(res);
      ok("正常 200 请求行为不变", status === 200 && body === "hello");
    }

    // ⑥ 404 也不该抛错（保持原有语义：把状态码交给调用方）
    {
      const res = await httpGetStream(`${base}/nope`);
      ok("404 原样返回，不抛错", res.status === 404, `status=${res.status}`);
      res.cleanup();
    }

    // ⑦ 进度回调只在真正下载时触发（重定向那几跳不该报进度）
    {
      const seen = [];
      const res = await httpGetStream(`${base}/a`, { onProgress: (r, t) => seen.push([r, t]) });
      await drain(res);
      ok("重定向跳不报进度，只有最终响应报", seen.length > 0 && seen[seen.length - 1][0] === 5, JSON.stringify(seen));
    }

    ok(`跳数上限为 ${MAX_REDIRECTS}`, MAX_REDIRECTS === 5);
  } finally {
    // ⚠️ 只调 close() 会挂住：keep-alive 连接还开着，close 的回调永远等不到。
    //    必须先掐掉所有连接（Node 18.2+ 的 closeAllConnections）。
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close();
  }

  console.log("\n自检结束");
  process.exit(FAILED);
}

// 兜底：任何一步卡住都不要把整个测试套件拖死
setTimeout(() => {
  console.log("FAIL  自检超时（20s）");
  process.exit(1);
}, 20000).unref();

main().catch((e) => {
  console.log("FAIL  自检异常中断  → " + e.message);
  process.exit(1);
});
