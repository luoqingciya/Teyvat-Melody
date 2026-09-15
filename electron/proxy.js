// proxy：HTTP 代理设置的解析与「要不要用」的判定。
//
// 全项目**没有运行时依赖**（package.json 的 dependencies 是空的），所以这里不引入
// undici / https-proxy-agent 之类，全部用 Node 原生 net/tls 自己实现 CONNECT 隧道。
//
// 为什么需要 CONNECT 隧道：用户填的代理是**普通 HTTP 代理**，而我们要访问的目标多数是
// https。http.Agent/https.Agent 只会「直连目标」，不能把请求交给代理；正确做法是
// 先向代理发 `CONNECT host:443`，把 TCP 打通，再在这条隧道上跑 TLS。
//
// 本文件只放**纯函数**（可单测）；真正建隧道在 proxyAgent.js。

const DEFAULT_PROXY_PORT = 7890; // 常见本地代理端口（Clash 等），仅作占位提示用

/**
 * 归一化用户在设置页填的代理配置。**任何不完整/非法的组合都退回「不使用代理」**，
 * 绝不让一个半填的配置把整个应用变成不能联网 —— 那比不生效更糟。
 *
 * @param {any} raw 形如 { enabled, host, port }
 * @returns {{enabled:boolean, host:string, port:number, url:string}}
 *          url 形如 "http://127.0.0.1:7890"，未启用时为空串
 */
function normalizeProxy(raw) {
  const off = { enabled: false, host: "", port: 0, url: "" };
  if (!raw || typeof raw !== "object") return off;
  if (!raw.enabled) return off;

  const host = String(raw.host == null ? "" : raw.host).trim();
  if (!host) return off;

  const port = parseInt(raw.port, 10);
  // 端口必须显式填且在合法区间 —— 不猜默认值（猜错会连到一个莫名其妙的端口）
  if (!Number.isFinite(port) || port < 1 || port > 65535) return off;

  return { enabled: true, host, port, url: `http://${host}:${port}` };
}

/**
 * 某个目标地址是否该走代理。
 *
 * ⚠️ `no_proxy` 列表在这里是**空的，但我们照样排除本机地址**：本项目前端与主进程都靠
 * `http://127.0.0.1:<动态端口>` 跟本地 Flask 通信（端口是主进程选空闲端口分配的）。
 * 一旦把本机请求也塞进代理，代理连不上就等于整个应用瘫痪 ——
 * 所以**本机地址永远直连**，这不是可配置项。
 *
 * @param {string} targetUrl
 * @param {{enabled:boolean, host:string, port:number}} proxy
 * @returns {boolean}
 */
function shouldProxy(targetUrl, proxy) {
  if (!proxy || !proxy.enabled) return false;
  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    return false; // 解析不了就不代理，交给调用方自己报错
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !isLoopbackHost(u.hostname);
}

/** 本机地址判定：localhost / 127.0.0.0-8 / ::1（以及 0.0.0.0） */
function isLoopbackHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  const m = h.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m;
}

/**
 * 给界面用的中文描述，例如「已启用：127.0.0.1:7890」/「未启用」。
 * 放在这里而不是前端，是为了让「什么算有效配置」只有一个定义处。
 */
function describeProxy(proxy) {
  if (!proxy || !proxy.enabled) return "未启用";
  return `${proxy.host}:${proxy.port}`;
}

/**
 * 判断一次「保存代理配置」的请求该不该被接受。
 *
 * 为什么单独抽出来：`main.js` 依赖 Electron、测不了，而这个判定的边界（关着开关时
 * 到底算「清空」还是「填错了」）恰恰是最容易出错、也最值得回归的地方。
 *
 * 两种拒绝情形：
 *  ① 启用了但配置不完整 → 拒绝。否则用户以为「开了」，实际静默直连。
 *  ② 没启用，但**填了内容且填错了** → 也拒绝。
 *     若放行，会存成 {enabled:false, host:"", port:0}，而输入框里还留着用户敲的字符；
 *     等他哪天把开关一拨「启用」，界面看着有值、存的却是空 —— 又一个「以为设了」的坑。
 * 只有「开关关着 + 两个框都空」才算正当的「清空配置」。
 *
 * @returns {{ok:true, proxy:{enabled:boolean,host:string,port:number}} | {ok:false, message:string}}
 */
function validateProxySave(input) {
  const { enabled, host, port } = input || {};
  const next = normalizeProxy({ enabled, host, port });
  if (enabled && !next.enabled) {
    return { ok: false, message: "请填写有效的代理主机与端口（1-65535）" };
  }
  // 判定「填错了」要看**字段本身**是否有效，不能用 next.enabled ——
  // 开关关着时 next.enabled 恒为 false，那样会把「先填好、暂不启用」也误杀掉。
  const rawHost = String(host ?? "").trim();
  const rawPort = String(port ?? "").trim();
  const touched = rawHost !== "" || rawPort !== "";
  const validAsOn = normalizeProxy({ enabled: true, host, port }).enabled;
  if (!enabled && touched && !validAsOn) {
    return { ok: false, message: "代理主机或端口填写有误（端口需为 1-65535），请检查后再关闭" };
  }
  // 接受时返回**按调用方 enabled 归一化**的结果：开关关着就该是 enabled:false，
  // 不能把探测用的结果透传出去。
  return { ok: true, proxy: { enabled: next.enabled, host: next.host, port: next.port } };
}

module.exports = {
  DEFAULT_PROXY_PORT,
  normalizeProxy,
  shouldProxy,
  isLoopbackHost,
  describeProxy,
  validateProxySave,
};
