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
const INIT_TIMEOUT = 10000; // inited 握手超时
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
// body 解析规则（对齐洛雪）：Content-Type 含 json → 对象；text/*、xml、html、javascript → utf8 字符串；其余 → Buffer
function lxRequest(url, options = {}, callback) {
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
          const ct = String(res.headers["content-type"] || "");
          let body;
          // 对齐洛雪：文本类响应一律先尝试 JSON.parse（部分平台 JSON 接口的
          // Content-Type 是 application/x-javascript 等非标值），失败再给字符串
          if (/json/i.test(ct)) {
            try { body = JSON.parse(buf.toString("utf8")); } catch { body = buf.toString("utf8"); }
          } else if (/^(image|audio|video)\//i.test(ct) || /octet-stream|protobuf/i.test(ct)) {
            body = buf; // 明确二进制 → Buffer
          } else {
            const text = buf.toString("utf8");
            try { body = JSON.parse(text); } catch { body = text; }
          }
          callback(null, {
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            url,
            body,
          });
        });
        res.on("error", (e) => callback(e));
      }
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", (e) => callback(e));
    if (payload) req.write(payload);
    req.end();
  } catch (e) {
    process.nextTick(() => callback(e));
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
  constructor(id, raw) {
    this.id = id;
    this.raw = raw;
    this.meta = parseMeta(raw);
    this.handlers = Object.create(null); // event -> handler
    this.sources = null; // inited 上报的源声明
    this.updateInfo = null; // updateAlert 载荷（每次运行仅一次）
    this._updateSent = false;
  }

  /** 执行脚本并等待 inited。失败 reject（超时 / 同步异常 / @name 缺失）。 */
  init() {
    return new Promise((resolve, reject) => {
      if (!this.meta.name) return reject(new Error("脚本缺少 @name 头部注释"));
      const timer = setTimeout(() => reject(new Error("源初始化超时（未收到 inited 事件）")), INIT_TIMEOUT);
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
        clearTimeout(timer);
        reject(new Error(`脚本执行异常：${e.message}`));
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
    const p = Promise.resolve().then(() => handler({ source, action, info }));
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("源响应超时")), CALL_TIMEOUT)
    );
    const result = await Promise.race([p, timeout]);
    return result;
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

module.exports = { SourceInstance, parseMeta, API_VERSION };
