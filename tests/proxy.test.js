// 代理配置自检：node tests/proxy.test.js
//
// 覆盖两件事：
//   1. 配置归一化与「要不要走代理」的判定（纯函数，易错点在边界）
//   2. **CONNECT 隧道**在真实 socket 上的行为 —— 起一个真正的本地 HTTP 代理来验，
//      而不是只调函数。隧道这段代码手写协议，不真跑一遍等于没测。
const net = require("net");
const http = require("http");
const { normalizeProxy, shouldProxy, isLoopbackHost, validateProxySave } = require("../electron/proxy");
const { createProxiedSocket, createProxyAgents, effectiveProxy } = require("../electron/proxyAgent");

// ---------------- bootstrap：把自签 CA 注入信任链 ----------------
// `NODE_EXTRA_CA_CERTS` 只在进程启动时读一次，所以这里是「先生成 CA → 带着它重启自己 →
// 第二次跑才进正片」。用环境变量传 CA 目录，避免重启后重复生成。
// 没有 openssl 就直接跳过 TLS 相关断言（不退化成 FAIL，因为这与被测代码无关）。
const CA_DIR_ENV = "TM_TEST_CA_DIR";
function bootstrapOrAbort() {
  const fs = require("fs");
  const path = require("path");
  if (!process.env[CA_DIR_ENV]) {
    const dir = makeCa();
    if (!dir) {
      console.log("SKIP  （本机没有 openssl，跳过 TLS 隧道断言 —— 其余断言照常跑）");
      return { skipTls: true };
    }
    const { spawnSync } = require("child_process");
    const r = spawnSync(process.execPath, [__filename], {
      stdio: "inherit",
      env: { ...process.env, [CA_DIR_ENV]: dir, NODE_EXTRA_CA_CERTS: path.join(dir, "ca.crt") },
    });
    process.exit(r.status === null ? 1 : r.status);
  }
  return { skipTls: false, caDir: process.env[CA_DIR_ENV] };
}

const BOOT = bootstrapOrAbort();

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

// ---------------- 一个最小的 HTTP 代理（只为测试存在） ----------------
// 支持 CONNECT（建隧道后原样对接上游）与绝对 URI 的普通 GET。
// 记录收到的 CONNECT 目标，供断言校验「代理确实被用到了、且目标正确」。
function startProxy({ auth = null, denyConnect = false, connectReject = 0 } = {}) {
  const connects = [];
  const plain = [];
  const server = http.createServer();
  server.on("request", (req, res) => {
    // 普通 HTTP 代理请求：req.url 是绝对 URI
    plain.push(req.url);
    if (auth && req.headers["proxy-authorization"] !== auth) {
      res.writeHead(407);
      return res.end("proxy auth required");
    }
    const target = new URL(req.url);
    const up = http.request(
      { hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      }
    );
    up.on("error", () => {
      res.writeHead(502);
      res.end("bad gateway");
    });
    req.pipe(up);
  });
  server.on("connect", (req, clientSocket, head) => {
    connects.push(req.url);
    if (connectReject) {
      // 模拟「把代理软件的控制接口当成代理端口」：那是个只接受 GET 的 REST API，
      // 收到 CONNECT 会回 `405 Method Not Allowed` + `Allow: GET`
      // （实测 mihomo / Clash 的控制接口默认在 9090，就是这种反应）。
      clientSocket.end(
        `HTTP/1.1 ${connectReject} ${connectReject === 405 ? "Method Not Allowed" : "Proxy Auth Required"}\r\n` +
          (connectReject === 405 ? "Allow: GET\r\n" : "") +
          "\r\n"
      );
      return;
    }
    if (denyConnect) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, connects, plain, close: () => server.close() });
    });
  });
}

(async () => {
  try {
    // ---- normalizeProxy：任何不完整配置都必须退回「未启用」 ----
    // 理由：半填的配置若被判为「已启用」，整个应用会连不上网，比不生效糟得多。
    ok("完整配置 → 启用并给出 url", (() => {
      const p = normalizeProxy({ enabled: true, host: "127.0.0.1", port: 7890 });
      return p.enabled && p.host === "127.0.0.1" && p.port === 7890 && p.url === "http://127.0.0.1:7890";
    })());
    ok("未勾选启用 → 关闭", !normalizeProxy({ enabled: false, host: "127.0.0.1", port: 7890 }).enabled);
    ok("缺主机 → 关闭", !normalizeProxy({ enabled: true, host: "   ", port: 7890 }).enabled);
    ok("缺端口 → 关闭（不猜默认端口）", !normalizeProxy({ enabled: true, host: "127.0.0.1" }).enabled);
    ok("端口非数字 → 关闭", !normalizeProxy({ enabled: true, host: "127.0.0.1", port: "abc" }).enabled);
    ok("端口越界 → 关闭", !normalizeProxy({ enabled: true, host: "127.0.0.1", port: 70000 }).enabled &&
      !normalizeProxy({ enabled: true, host: "127.0.0.1", port: 0 }).enabled);
    ok("端口是字符串数字 → 接受并转成整数", normalizeProxy({ enabled: true, host: "h", port: "8080" }).port === 8080);
    ok("主机前后空格 → 去掉", normalizeProxy({ enabled: true, host: " 127.0.0.1 ", port: 1 }).host === "127.0.0.1");
    ok("传入 null / 非对象 → 关闭且不抛错", !normalizeProxy(null).enabled && !normalizeProxy("x").enabled && !normalizeProxy(undefined).enabled);

    // ---- isLoopbackHost ----
    ok("localhost 是本机", isLoopbackHost("localhost") && isLoopbackHost("LOCALHOST"));
    ok("127.x 是本机", isLoopbackHost("127.0.0.1") && isLoopbackHost("127.9.9.9"));
    ok("::1 / 0.0.0.0 是本机", isLoopbackHost("::1") && isLoopbackHost("0.0.0.0"));
    ok("普通域名不是本机", !isLoopbackHost("api.github.com") && !isLoopbackHost("music.163.com"));
    ok("127 开头的假域名不算（127.example.com）", !isLoopbackHost("127.example.com"));

    // ---- shouldProxy ----
    const on = normalizeProxy({ enabled: true, host: "127.0.0.1", port: 7890 });
    ok("启用时代理外网 https", shouldProxy("https://api.github.com/x", on));
    ok("启用时代理外网 http", shouldProxy("http://example.com/x", on));
    // 最关键的一条：本机必须直连。前端与主进程全靠 127.0.0.1:<动态端口> 跟本地 Flask 通信，
    // 一旦被塞进代理，代理连不上就等于整个应用瘫痪。
    ok("⚠️ 本机地址永远直连（否则设了代理会让应用连不上自己的后端）",
      !shouldProxy("http://127.0.0.1:53211/api/songs", on) && !shouldProxy("http://localhost:5000/", on));
    ok("未启用时都不代理", !shouldProxy("https://api.github.com/x", normalizeProxy({}).enabled ? on : { enabled: false }));
    ok("非 http(s) 协议不代理", !shouldProxy("file:///C:/x", on) && !shouldProxy("ftp://a/b", on));
    ok("非法 URL 不代理且不抛错", !shouldProxy("not a url", on));

    // ---- effectiveProxy：所有请求点的统一收口（含本机直连） ----
    // 主进程三处请求（源宿主 / 搜索 / 更新下载与通知图标）都走它，
    // 这样「哪些地址不该代理」只有一处判据，不会各写各的。
    ok("effectiveProxy 对外网返回原代理", (() => {
      const e = effectiveProxy("https://api.github.com/x", on);
      return e.enabled && e.port === 7890;
    })());
    ok("⚠️ effectiveProxy 对本机返回「未启用」（后端/前端全靠 127.0.0.1，代理了就连不上）",
      effectiveProxy("http://127.0.0.1:5000/api/songs", on).enabled === false);
    ok("effectiveProxy 对未启用配置返回「未启用」",
      effectiveProxy("https://api.github.com/x", { enabled: false }).enabled === false);
    ok("effectiveProxy 对 file:// 等非 http(s) 返回「未启用」",
      effectiveProxy("file:///C:/x", on).enabled === false);

    // ---- validateProxySave：保存时该不该收下这份配置 ----
    // 这是「用户以为设了代理、其实没设」这类投诉的唯一防线，边界必须钉死。
    ok("启用 + 完整配置 → 接受", (() => {
      const r = validateProxySave({ enabled: true, host: "127.0.0.1", port: 7890 });
      return r.ok && r.proxy.enabled && r.proxy.port === 7890;
    })());
    ok("启用 + 缺端口 → 拒绝（不能静默直连）",
      (() => { const r = validateProxySave({ enabled: true, host: "127.0.0.1" }); return !r.ok && /端口/.test(r.message); })());
    ok("启用 + 端口非数字 → 拒绝",
      (() => { const r = validateProxySave({ enabled: true, host: "127.0.0.1", port: "abc" }); return !r.ok; })());
    ok("启用 + 端口越界 → 拒绝",
      (() => { const r = validateProxySave({ enabled: true, host: "127.0.0.1", port: 99999 }); return !r.ok; })());

    // ⚠️ 关键回归：开关关着、但用户填了错的端口 —— 也必须拒绝。
    // 放行的话会存成 {enabled:false,host:"",port:0}，输入框里却还留着 "abc"；
    // 用户下次一拨开关就以为生效了，实际是空配置。
    ok("⚠️ 未启用 + 填了非法端口 → 拒绝（否则存成空配置，用户以为下次开了就生效）",
      (() => { const r = validateProxySave({ enabled: false, host: "127.0.0.1", port: "abc" }); return !r.ok && /有误/.test(r.message); })());
    ok("未启用 + 只填了主机（端口空）→ 拒绝",
      (() => { const r = validateProxySave({ enabled: false, host: "127.0.0.1", port: "" }); return !r.ok; })());
    ok("未启用 + 两框都空 → 接受（这才是正当的「清空配置」）",
      (() => { const r = validateProxySave({ enabled: false, host: "", port: "" }); return r.ok && r.proxy.enabled === false; })());
    ok("未启用 + 完整合法配置 → 接受（先填好、暂不启用是正常操作）",
      (() => { const r = validateProxySave({ enabled: false, host: "127.0.0.1", port: 7890 }); return r.ok && r.proxy.enabled === false; })());
    ok("参数全缺 → 当作清空，接受", validateProxySave({}).ok && validateProxySave(undefined).ok);
    ok("接受的返回值只含三个字段（不会把 enabled:undefined 之类漏给配置文件）", (() => {
      const r = validateProxySave({ enabled: true, host: " h ", port: "8080" });
      return r.ok && Object.keys(r.proxy).sort().join() === "enabled,host,port" && r.proxy.host === "h" && r.proxy.port === 8080;
    })());

    // ---- CONNECT 隧道：起一个真代理，跑真的 TLS 请求 ----
    const proxy = await startProxy();
    const tlsServer = BOOT.skipTls ? { port: 0, close: () => {} } : await startTlsEcho(BOOT.caDir);
    let tsSocket;
    try {
      if (!BOOT.skipTls) {
        // ① 隧道能建起来
        await new Promise((resolve, reject) => {
          createProxiedSocket(
            { enabled: true, host: "127.0.0.1", port: proxy.port },
            { host: "127.0.0.1", port: tlsServer.port, servername: "localhost", isHttps: true },
            (err, socket) => {
              if (err) return reject(err);
              tsSocket = socket;
              resolve();
            }
          );
        });
        ok("CONNECT 隧道建立成功（https 目标）", !!tsSocket);
        ok("代理确实收到了 CONNECT，且目标写对", proxy.connects.includes(`127.0.0.1:${tlsServer.port}`), JSON.stringify(proxy.connects));
        ok("拿到的是已加密的 TLS socket（可当 https agent 的 socket 用）", !!tsSocket.encrypted);
        ok("隧道里的证书通过了真实校验（没有为了让测试过而关掉 rejectUnauthorized）", !!tsSocket.authorized);
        try { tsSocket.destroy(); } catch { /* ignore */ }

        // ② 走 agent 发一个真实的 HTTPS 请求 —— 这才算端到端验证
        const agents = createProxyAgents({ enabled: true, host: "127.0.0.1", port: proxy.port });
        const body = await new Promise((resolve, reject) => {
          const req = require("https").request(
            {
              hostname: "localhost",
              port: tlsServer.port,
              path: "/hello",
              method: "GET",
              agent: agents.https,
            },
            (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
            }
          );
          req.on("error", reject);
          req.end();
        });
        ok("经代理的 HTTPS 请求拿到 200", body.status === 200, JSON.stringify(body));
        ok("经代理的响应内容正确", /hello/i.test(body.text), body.text);

        // ③ 代理拒绝 CONNECT 时要给出明确错误，而不是让请求永远挂着
        const denyProxy = await startProxy({ denyConnect: true });
        try {
          const err = await new Promise((resolve) => {
            createProxiedSocket(
              { enabled: true, host: "127.0.0.1", port: denyProxy.port },
              { host: "127.0.0.1", port: tlsServer.port, servername: "localhost", isHttps: true },
              (e) => resolve(e)
            );
          });
          ok("代理拒绝隧道 → 回调带错误（不会挂住）", !!err && /403|拒绝/.test(err.message), err && err.message);
        } finally {
          denyProxy.close();
        }

        // ③b) 把「代理软件的控制接口」当成代理端口（实测最常见的填错方式）。
        //     只报「405 Method Not Allowed」用户根本猜不到是端口错了，必须点出来。
        const ctlProxy = await startProxy({ connectReject: 405 });
        try {
          const err = await new Promise((resolve) => {
            createProxiedSocket(
              { enabled: true, host: "127.0.0.1", port: ctlProxy.port },
              { host: "127.0.0.1", port: tlsServer.port, servername: "localhost", isHttps: true },
              (e) => resolve(e)
            );
          });
          ok("405 + Allow: GET → 提示「这是控制接口，不是代理端口」",
            !!err && /405/.test(err.message) && /控制接口/.test(err.message) && /7890/.test(err.message),
            err && err.message);
        } finally {
          ctlProxy.close();
        }

        // ③c) 代理要求认证 → 提示不支持带认证的代理
        const authProxy = await startProxy({ connectReject: 407 });
        try {
          const err = await new Promise((resolve) => {
            createProxiedSocket(
              { enabled: true, host: "127.0.0.1", port: authProxy.port },
              { host: "127.0.0.1", port: tlsServer.port, servername: "localhost", isHttps: true },
              (e) => resolve(e)
            );
          });
          ok("407 → 提示代理需要认证", !!err && /407/.test(err.message) && /认证/.test(err.message), err && err.message);
        } finally {
          authProxy.close();
        }

        // ④ 代理端口没人监听 → 明确报「连接代理失败」
        const deadPort = await freePort();
        const err2 = await new Promise((resolve) => {
          createProxiedSocket(
            { enabled: true, host: "127.0.0.1", port: deadPort },
            { host: "127.0.0.1", port: tlsServer.port, servername: "localhost", isHttps: true },
            (e) => resolve(e)
          );
        });
        ok("代理不可达 → 错误信息点明是「连接代理」失败（便于用户排查）",
          !!err2 && /代理/.test(err2.message), err2 && err2.message);
      }

      // ⑤ 普通 http 目标也走隧道（我们统一用 CONNECT，不走绝对 URI 那条路）
      //    这条不依赖 TLS，所以 openssl 缺失时也要跑。
      const plainServer = await startPlainEcho();
      try {
        const agents2 = createProxyAgents({ enabled: true, host: "127.0.0.1", port: proxy.port });
        const r = await new Promise((resolve, reject) => {
          const req = require("http").request(
            { hostname: "127.0.0.1", port: plainServer.port, path: "/plain", method: "GET", agent: agents2.http },
            (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
            }
          );
          req.on("error", reject);
          req.end();
        });
        ok("http 目标也能经隧道取回（走 CONNECT 而非绝对 URI）", r.status === 200 && /plain/i.test(r.text), JSON.stringify(r));
        ok("http 隧道确实经过代理（代理记录了该目标的 CONNECT）",
          proxy.connects.includes(`127.0.0.1:${plainServer.port}`), JSON.stringify(proxy.connects));
      } finally {
        plainServer.close();
      }
    } finally {
      proxy.close();
      tlsServer.close();
    }
  } catch (e) {
    console.log(`FAIL  自检异常中断  → ${e.message}`);
    console.log(e.stack);
    process.exitCode = 1;
  } finally {
    console.log("\n自检结束");
  }
})();

/**
 * 起一个本地 HTTPS 服务器，**证书由本测试自己签的 CA 签出**，并把这个 CA 塞进
 * `NODE_EXTRA_CA_CERTS` —— 于是 `createProxiedSocket` 里写死的
 * `rejectUnauthorized: true` 依然能通过校验。
 *
 * 为什么不直接在测试里传 `rejectUnauthorized:false`：**生产代码刻意不做这个开关**。
 * 隧道在 TLS 握手阶段就完成证书校验（这是它该做的），若为了让测试跑通而加一个
 * 「跳过校验」的口子，就等于给真实流量开了同一个口子。测试应当去适配生产的安全设定，
 * 而不是反过来把生产改松。
 *
 * ⚠️ `NODE_EXTRA_CA_CERTS` 只在**进程启动时**读取一次。所以本文件在真正跑断言之前
 * 会先检查环境变量：没设置就带着自签 CA 重新拉起自己（见文件末尾的 bootstrap）。
 */
function startTlsEcho(caDir) {
  const fs = require("fs");
  const path = require("path");
  const https = require("https");
  const key = path.join(caDir, "server.key");
  const crt = path.join(caDir, "server.crt");
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello over proxy tunnel");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

/** 用 openssl 生成一套「CA + 由它签出的 localhost 服务器证书」，返回目录；失败返回 null */
function makeCa() {
  const { execFileSync } = require("child_process");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-ca-"));
  const caKey = path.join(dir, "ca.key");
  const caCrt = path.join(dir, "ca.crt");
  const key = path.join(dir, "server.key");
  const csr = path.join(dir, "server.csr");
  const crt = path.join(dir, "server.crt");
  const ext = path.join(dir, "ext.cnf");
  fs.writeFileSync(ext, "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  try {
    const run = (args) => execFileSync("openssl", args, { stdio: "ignore" });
    // ① 自签 CA
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCrt,
      "-days", "1", "-subj", "/CN=TM Test CA"]);
    // ② 服务器私钥 + CSR
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=localhost"]);
    // ③ 由 CA 签出，且带 SAN（现代 TLS 校验要求 SAN，不看 CN）
    run(["x509", "-req", "-in", csr, "-CA", caCrt, "-CAkey", caKey, "-CAcreateserial",
      "-out", crt, "-days", "1", "-extfile", ext]);
  } catch {
    return null;
  }
  for (const f of ["server.key", "server.crt", "ca.crt"]) {
    if (!fs.existsSync(path.join(dir, f))) return null;
  }
  return dir;
}

function startPlainEcho() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("plain http response");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
