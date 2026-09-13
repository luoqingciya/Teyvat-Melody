// sourceHost：洛雪音乐自定义源宿主运行时。
// 用 Node vm 为每个源脚本创建独立沙箱，注入 globalThis.lx（事件桥 + 无跨域 HTTP + crypto/zlib 工具），
// 行为对齐洛雪桌面版自定义源 API：https://lxmusic.toside.cn/desktop/custom-source
//
// 安全模型（与洛雪一致）：源脚本为用户自行导入的第三方代码，可发起任意网络请求；
// 沙箱不注入 require/process/Buffer 等 Node 全局，仅提供 lx.utils 中的受控能力。
const vm = require("vm");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const crypto = require("crypto");

const API_VERSION = "3.0.0"; // 对齐洛雪桌面版自定义源 API 版本
// inited 握手超时：真实第三方源（尤其混淆过的）常在 init 阶段做多步服务端握手，
// 10s 在弱网/代理环境下容易误判失败，放宽到 30s。
const INIT_TIMEOUT = 30000;
const CALL_TIMEOUT = 20000; // 单次 request action 超时

// ---------------- 脚本头部注释元数据 ----------------
// 格式：/** @name xxx */ 或 /*! @name xxx */（第三方源常用压缩保留注释风格，两种都兼容）
function parseMeta(raw) {
  const meta = { name: "", description: "", version: "", author: "", homepage: "" };
  const m = raw.match(/\/\*[*!]([\s\S]*?)\*\//);
  if (!m) return meta;
  for (const key of Object.keys(meta)) {
    const km = m[1].match(new RegExp(`@${key}[\\s:]+([^\\n*]+)`));
    if (km) meta[key] = km[1].trim();
  }
  return meta;
}

// ---------------- lx.request：无跨域 HTTP ----------------
// options: { method, headers, body, form, formData, timeout }
// callback(err, resp)，resp = { statusCode, statusMessage, headers, url, body }

/**
 * 响应体解析：**以内容判定为主、Content-Type 为辅**。
 *
 * 大量平台的 JSON 接口 Content-Type 都是非标值（application/x-javascript、text/plain，
 * 甚至 application/octet-stream）。若只按 Content-Type 判定就当作二进制处理，
 * 源脚本会拿到 Buffer 而非对象，`body.code` 之类的取值直接失败
 * （实测：某源后端返回 JSON 却标 octet-stream，源据此抛"服务器异常"）。
 * 因此先看内容是否像 JSON，再看类型决定字符串还是 Buffer。
 */
function parseBody(buf, contentType) {
  const ct = String(contentType || "");
  const text = buf.toString("utf8");
  if (/^\s*[{[]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* 形似 JSON 但解析失败：落到下面按类型处理 */
    }
  }
  const isTexty = /json|javascript|text|xml|html|urlencoded/i.test(ct) || !ct;
  const isBinary = /^(image|audio|video|font)\//i.test(ct) || /octet-stream|protobuf|zip|pdf|wasm/i.test(ct);
  return isBinary && !isTexty ? buf : text;
}

function lxRequest(url, options = {}, callback) {
  // 源脚本在 request 回调里抛错时，异常会沿 Node 的事件回调冒泡成**未捕获异常**，
  // 直接把 Electron 主进程打崩（一个行为不端的源就能让整个应用挂掉）。
  // 这里统一兜住：源自身的问题只记日志，绝不影响宿主进程。
  const safeCallback = (err, resp) => {
    try {
      callback(err, resp);
    } catch (e) {
      console.error("[自定义源] request 回调抛出异常（已隔离）:", e && e.message);
    }
  };

  let req;
  try {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const headers = { ...(options.headers || {}) };
    let payload = null;

    if (options.form && typeof options.form === "object") {
      payload = Buffer.from(new URLSearchParams(options.form).toString());
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (options.formData && typeof options.formData === "object") {
      const boundary = "----lxform" + crypto.randomBytes(8).toString("hex");
      const parts = [];
      for (const [k, v] of Object.entries(options.formData)) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
      }
      parts.push(`--${boundary}--\r\n`);
      payload = Buffer.from(parts.join(""));
      headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
    } else if (options.body != null) {
      payload = Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body));
    }
    if (payload && !headers["content-length"]) headers["content-length"] = payload.length;

    req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: (options.method || "GET").toUpperCase(),
        headers,
        timeout: options.timeout || 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const body = parseBody(buf, res.headers["content-type"]);
          safeCallback(null, {
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            url,
            body,
          });
        });
        res.on("error", (e) => safeCallback(e));
      }
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (e) => safeCallback(e));
    if (payload) req.write(payload);
    req.end();
  } catch (e) {
    process.nextTick(() => safeCallback(e));
  }
  // 返回取消函数（洛雪契约）
  return () => { try { req && req.destroy(); } catch {} };
}

// ---------------- lx.utils ----------------
const lxUtils = {
  buffer: {
    from: (data, encoding) => Buffer.from(data, encoding),
    bufToString: (buf, format) => Buffer.from(buf).toString(format),
  },
  crypto: {
    aesEncrypt(buffer, mode, key, iv) {
      // mode 为完整算法名（如 aes-128-cbc / aes-128-ecb）；ecb 时 iv 传 null
      const cipher = crypto.createCipheriv(mode, Buffer.from(key), iv ? Buffer.from(iv) : null);
      return Buffer.concat([cipher.update(Buffer.from(buffer)), cipher.final()]);
    },
    md5: (str) => crypto.createHash("md5").update(str).digest("hex"),
    randomBytes: (size) => crypto.randomBytes(size),
    rsaEncrypt(buffer, key) {
      return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(buffer));
    },
  },
  zlib: {
    inflate: (buf) =>
      new Promise((resolve, reject) =>
        zlib.inflate(Buffer.from(buf), (e, r) => (e ? reject(e) : resolve(r)))
      ),
    deflate: (buf) =>
      new Promise((resolve, reject) =>
        zlib.deflate(Buffer.from(buf), (e, r) => (e ? reject(e) : resolve(r)))
      ),
  },
};

// ---------------- 源实例 ----------------
class SourceInstance {
  /**
   * @param {string} id 源 id（文件名去扩展名）
   * @param {string} raw 脚本源码
   * @param {{initTimeout?: number}} [options] initTimeout 可覆盖默认握手超时（自检/快速失败用）
   */
  constructor(id, raw, options = {}) {
    this.id = id;
    this.raw = raw;
    this.meta = parseMeta(raw);
    this.handlers = Object.create(null); // event -> handler
    this.sources = null; // inited 上报的源声明
    this.updateInfo = null; // updateAlert 载荷（每次运行仅一次）
    this._updateSent = false;
    const t = Number(options.initTimeout);
    this.initTimeout = Number.isFinite(t) && t > 0 ? t : INIT_TIMEOUT;
  }

  /** 执行脚本并等待 inited。失败 reject（超时 / 同步异常 / @name 缺失）。 */
  init() {
    return new Promise((resolve, reject) => {
      if (!this.meta.name) return reject(new Error("脚本缺少 @name 头部注释"));

      let timer = null;
      // 失败信息带上源在 init 阶段上报的 updateAlert：很多源会因"版本过低"主动拒绝初始化，
      // 此时真实原因是更新提示而非超时，只报"超时"会让用户完全无从下手。
      const fail = (msg) => {
        clearTimeout(timer);
        const hint = this.updateInfo?.log ? `；该源提示：${this.updateInfo.log}` : "";
        const url = this.updateInfo?.updateUrl ? `（更新地址：${this.updateInfo.updateUrl}）` : "";
        reject(new Error(msg + hint + url));
      };
      timer = setTimeout(() => fail("源初始化超时（未收到 inited 事件）"), this.initTimeout);
      this._resolveInited = (sources) => {
        clearTimeout(timer);
        this.sources = sources;
        resolve(sources);
      };

      const tag = `[源:${this.meta.name}]`;
      const sandboxConsole = {
        log: (...a) => console.log(tag, ...a),
        info: (...a) => console.log(tag, ...a),
        warn: (...a) => console.warn(tag, ...a),
        error: (...a) => console.error(tag, ...a),
        group: () => {},
        groupEnd: () => {},
      };

      const lx = this._buildLx();
      const sandbox = {
        lx,
        console: sandboxConsole,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        queueMicrotask,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        atob: (s) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s) => Buffer.from(s, "binary").toString("base64"),
      };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      this._context = sandbox;

      try {
        vm.runInContext(this.raw, sandbox, { filename: `${this.meta.name}.js` });
      } catch (e) {
        fail(`脚本执行异常：${e.message}`);
      }
    });
  }

  _buildLx() {
    const self = this;
    return {
      version: API_VERSION,
      env: "desktop",
      currentScriptInfo: { ...this.meta, rawScript: this.raw },
      EVENT_NAMES: { inited: "inited", request: "request", updateAlert: "updateAlert" },
      on(event, handler) {
        self.handlers[event] = handler;
      },
      send(event, data) {
        if (event === "inited") {
          self._resolveInited && self._resolveInited((data && data.sources) || {});
        } else if (event === "updateAlert" && !self._updateSent) {
          self._updateSent = true;
          self.updateInfo = { log: String(data?.log ?? "").slice(0, 1024), updateUrl: data?.updateUrl || "" };
        }
      },
      request: lxRequest,
      utils: lxUtils,
    };
  }

  /** 调用脚本注册的 request handler。返回脚本 Promise 的结果（带超时）。 */
  async call(source, action, info) {
    const handler = this.handlers.request;
    if (!handler) throw new Error("源未注册 request 处理回调");
    // 超时定时器必须在竞速结束后清理：否则每次调用都留一个 20s 的 timer 吊住事件循环
    //（表现为进程/自检迟迟不退出），长会话下还会持续累积。
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("源响应超时")), CALL_TIMEOUT);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => handler({ source, action, info })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 列表展示用摘要 */
  summary(enabled) {
    return {
      id: this.id,
      name: this.meta.name,
      description: this.meta.description,
      version: this.meta.version,
      author: this.meta.author,
      homepage: this.meta.homepage,
      enabled: !!enabled,
      sources: this.sources || {},
      updateInfo: this.updateInfo,
    };
  }
}

module.exports = { SourceInstance, parseMeta, parseBody, API_VERSION };
