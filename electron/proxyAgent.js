// proxyAgent：把 Node 原生 http/https 请求接到用户配置的 HTTP 代理上。
//
// 为什么自己写：项目**零运行时依赖**（见 MEMORY「零运行时依赖」），不能引
// https-proxy-agent / undici。而原生 `http.Agent` / `https.Agent` 没有「走代理」这个能力 ——
// 它们只负责直连目标。所以这里自己实现标准做法：**CONNECT 隧道**。
//
//   客户端 --CONNECT api.example.com:443--> 代理
//   代理   --200 Connection Established--> 客户端
//   客户端 <==== TLS(=https://api.example.com) ====> 代理 <===> 目标
//
// http 目标（非 https）本来可以直接把绝对 URI 发给代理，但为了少一条代码路径、少一份出错面，
// **统一都走 CONNECT** —— 主流代理都支持，行为一致比省一次握手重要。
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");

const CONNECT_TIMEOUT = 15000;

/**
 * 隧道被拒时补一句「最可能的原因」—— 光看到状态码用户无从下手。
 *
 * 实测最常见的坑：**把代理软件的控制接口当成代理端口填了**。
 * 例如 Clash / mihomo 的 `external-controller` 默认就在 9090，那是个只接受 GET 的
 * REST API（`GET /` 会回 `{"hello":"mihomo"}`）；收到 CONNECT 就回
 * `405 Method Not Allowed` + `Allow: GET`。真正的代理端口是 `mixed-port`，默认 7890。
 * 用户只看到「405」根本猜不到是端口填错。
 */
function tunnelHint(status, head) {
  if (status === 405 && /^allow:\s*get/im.test(head)) {
    return (
      "：该端口只接受 GET，看起来是代理软件的「控制接口」而不是代理端口" +
      "（Clash / mihomo 的控制接口默认 9090；代理端口是 mixed-port，默认 7890），请改填代理端口"
    );
  }
  if (status === 407) {
    return "：代理要求认证，本软件暂不支持带用户名密码的代理";
  }
  if (status === 400 || status === 501) {
    return "：该端口可能不是 HTTP 代理（或不支持 CONNECT 隧道）";
  }
  if (status === 403) {
    return "：代理拒绝了这次连接，请检查代理的访问规则";
  }
  return "";
}

/**
 * 建立到目标的 socket（必要时先穿过代理）。
 *
 * 语义对齐 `http.Agent#createConnection`：成功时 `cb(null, socket)`，
 * 失败时 `cb(err)` —— 这样它才能被 http/https 模块原样使用。
 *
 * @param {{host:string, port:number}} proxy 已归一化的代理
 * @param {{host:string, port:number, servername?:string, isHttps:boolean}} opts
 * @param {(err:Error|null, socket?:import("net").Socket)=>void} cb
 */
function createProxiedSocket(proxy, opts, cb) {
  // 目标可能是 IP 或域名；CONNECT 需要 host:port
  const target = `${opts.host}:${opts.port}`;
  let settled = false;
  const done = (err, socket) => {
    if (settled) {
      // 已经回调过了：后续的 socket 必须销毁，否则会泄漏一个半开连接
      if (socket && !err) socket.destroy();
      return;
    }
    settled = true;
    cb(err, socket);
  };

  const onProxy = net.connect({ host: proxy.host, port: proxy.port });
  onProxy.setTimeout(CONNECT_TIMEOUT, () => {
    onProxy.destroy(new Error(`连接代理超时（${proxy.host}:${proxy.port}）`));
  });

  onProxy.on("error", (e) => {
    onProxy.destroy();
    done(new Error(`连接代理失败（${proxy.host}:${proxy.port}）：${e.message}`));
  });

  onProxy.on("connect", () => {
    onProxy.setTimeout(0); // 握手阶段结束后不要再套用连接超时
    // CONNECT 只带主机名与端口，不泄露路径；Host 头按惯例带上
    onProxy.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });

  // 逐块累积直到出现 \r\n\r\n —— 代理的响应可能被 TCP 拆成多个包，
  // 收到第一个 data 就解析是最常见的错误，偶发失败且极难复现。
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buf.length > 8192) {
        onProxy.destroy(new Error("代理响应异常（响应头过长）"));
      }
      return;
    }
    onProxy.removeListener("data", onData);

    const head = buf.subarray(0, end).toString("latin1");
    const m = head.match(/^HTTP\/\d\.\d\s+(\d{3})/);
    const status = m ? parseInt(m[1], 10) : 0;
    if (status !== 200) {
      onProxy.destroy();
      const firstLine = head.split("\r\n")[0] || "";
      done(new Error(`代理拒绝隧道（${firstLine || "无响应"}）${tunnelHint(status, head)}`));
      return;
    }

    // 建好隧道后分两路：https 要在隧道上再跑 TLS，http 直接复用这条 socket
    const rest = buf.subarray(end + 4); // CONNECT 之后可能还粘了数据，别丢
    if (rest.length) onProxy.unshift(rest);

    if (!opts.isHttps) {
      done(null, onProxy);
      return;
    }

    const tlsSocket = tls.connect({
      socket: onProxy,
      servername: opts.servername || opts.host, // SNI：目标证书要按域名校验
      rejectUnauthorized: true,
    });
    tlsSocket.once("secureConnect", () => {
      tlsSocket.setTimeout(0);
      done(null, tlsSocket);
    });
    tlsSocket.once("error", (e) => {
      tlsSocket.destroy();
      done(new Error(`代理隧道 TLS 握手失败：${e.message}`));
    });
  };

  onProxy.on("data", onData);
  onProxy.once("close", () => {
    // 隧道在握手完成前就被关掉（代理崩了/被墙）→ 给一个明确错误，别让请求永远挂着
    if (!settled) done(new Error("代理在建立隧道前断开了连接"));
  });
}

/**
 * 生成一对 http/https Agent，交给请求用。
 *
 * 把「解析 host/port」这一步**留给 Node 自己**：传入的 options 已经由 http 模块规范化过
 * （可能是 `hostname`，也可能 `host` 带端口，还有 `defaultPort`），自己再解析一遍很容易与
 * Node 的规则不一致。所以这里只补 `createConnection`。
 *
 * @param {{host:string, port:number}} proxy
 * @returns {{http: import("http").Agent, https: import("https").Agent}}
 */
function createProxyAgents(proxy) {
  const make = (isHttps) => {
    class ProxiedAgent extends (isHttps ? https.Agent : http.Agent) {
      createConnection(options, cb) {
        const host = options.hostname || options.host;
        const port = options.port || (isHttps ? 443 : 80);
        createProxiedSocket(
          proxy,
          { host, port, servername: options.servername || host, isHttps },
          cb
        );
        // Agent 的契约：这里不返回 socket（异步回调里给）
        return undefined;
      }
    }
    return new ProxiedAgent({ keepAlive: false });
  };
  return { http: make(false), https: make(true) };
}

/** 给一组请求 options 注入代理 agent；未启用代理时原样返回（浅拷贝，不改调用方的对象）。 */
function withProxyOptions(options, proxy) {
  if (!proxy || !proxy.enabled) return options;
  const { http: httpAgent, https: httpsAgent } = createProxyAgents(proxy);
  const isHttps = !options.protocol || options.protocol === "https:";
  return { ...options, agent: isHttps ? httpsAgent : httpAgent };
}

/**
 * 按目标 URL 决定「这次到底要不要走代理」。
 *
 * 存在的意义：**本机地址必须直连**。前端、主进程、本地 Flask 全靠
 * `http://127.0.0.1:<动态端口>` 通信；把这类地址塞进代理，等于让代理去连一个
 * 只有本机才有的端口 —— 必然失败，而且失败得很莫名（用户只会看到「全都连不上」）。
 * 判据集中在 electron/proxy.js 的 shouldProxy（已单测覆盖），这里只做「要不要用」的收口。
 */
function effectiveProxy(url, proxy) {
  if (!proxy || !proxy.enabled) return { enabled: false, host: "", port: 0 };
  const { shouldProxy } = require("./proxy");
  return shouldProxy(url, proxy) ? proxy : { enabled: false, host: "", port: 0 };
}

module.exports = {
  createProxiedSocket,
  createProxyAgents,
  withProxyOptions,
  effectiveProxy,
  CONNECT_TIMEOUT,
};
