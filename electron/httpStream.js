// httpStream：以「流式 GET 到文件」的方式请求一个 URL，并回报进度。
//
// 从 main.js 抽出来是为了**能单测**（main.js 依赖 Electron，测不了）——
// 这里唯一依赖 appConfig 与 proxyAgent，两者在测试里都可控。
//
// 刻意用原生 http/https 而不是 fetch：项目零运行时依赖，而主进程内
// `require("undici")` 拿不到（Node 内置但没暴露），所以 fetch 想走用户配置的
// HTTP 代理做不到 —— 只能原生请求 + 自写 CONNECT 隧道 agent（见 proxyAgent.js）。
// 更新包有 90 多 MB，正好也要流式落盘。
const { PassThrough } = require("stream");
const proxyAgent = require("./proxyAgent");
const appConfig = require("./appConfig");
const { redirectTarget, MAX_REDIRECTS } = require("./httpRedirect");

/**
 * @param {string} url
 * @param {{onProgress?: (received:number, total:number)=>void, _depth?: number}} [opts]
 * @returns {Promise<{status:number, headers:object, stream:import("stream").Readable, cleanup:Function}>}
 */
function httpGetStream(url, { onProgress, _depth = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`非法 URL：${url}`));
    }
    // ⚠️ 本机地址永远直连：通知图标传进来的其实是本机封面代理的 URL
    //（http://127.0.0.1:<后端端口>/api/online/image?...），塞进代理就会拉不到图。
    // 重定向后的新地址会重新走一遍这里，所以 CDN 主机名也会重新判定该不该走代理。
    const proxy = proxyAgent.effectiveProxy(url, appConfig.proxyConfig());
    const lib = u.protocol === "https:" ? require("https") : require("http");
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: { "User-Agent": "TeyvatMelody", Accept: "*/*" },
    };
    const req = lib.request(proxyAgent.withProxyOptions(opts, proxy), (res) => {
      // ⚠️⚠️ 必须跟随重定向：GitHub 的 Release 资产下载地址会
      //   github.com/…/releases/download/… --302--> release-assets.githubusercontent.com
      // 不跟就只会看到「HTTP 302」，而且**开不开代理都一样** ——
      // 那是代码问题不是网络问题（用户很容易误以为是代理没配好，白折腾）。
      const next = redirectTarget(res.statusCode, res.headers.location, url);
      if (next) {
        res.resume();
        if (_depth >= MAX_REDIRECTS) {
          return reject(new Error(`重定向次数过多（>${MAX_REDIRECTS}）`));
        }
        return httpGetStream(next, { onProgress, _depth: _depth + 1 }).then(resolve, reject);
      }
      const total = Number(res.headers["content-length"]) || 0;
      // ⚠️⚠️ 必须经过一个 PassThrough 再交给调用方，**不能直接在 res 上挂 'data' 计数**。
      // 原因：挂上 'data' 监听会把响应切成「流动模式」，而调用方是在 `await httpGetStream()`
      // 之后才挂自己的监听/开始 for-await 的 —— 在此之前到达的分片会被直接丢掉。
      // 实测本地小响应会丢掉**第一块**（内容只剩后半截）；更新包那种大响应因为分片来得慢
      // 侥幸没暴露，但同样有丢数据的风险（下载下来的文件会损坏）。
      // 改为 pipe 到 PassThrough：计数与交付互不干扰，调用方想怎么读都行。
      const out = new PassThrough();
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.on("error", (e) => out.destroy(e));
      res.pipe(out);
      resolve({
        status: res.statusCode,
        headers: res.headers,
        stream: out,
        cleanup: () => {
          res.destroy();
          out.destroy();
        },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

module.exports = { httpGetStream };
