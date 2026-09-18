// logger：落盘日志（默认 `<数据根>/logs/app.log`）。
//
// 为什么需要它：**打包后的应用没有控制台** —— 所有 console.* 都进了黑洞。
// 用户报障时我们手里什么都没有，只能靠复现去猜，而真正难查的恰恰是偶发问题
// （后端崩溃、源脚本报错、更新失败）。有了日志，这些问题至少留下现场。
//
// 三条硬约定：
//   · **永不抛错**：日志写不进去（盘满 / 权限 / 文件被占用）绝不能把应用带崩，
//     最多静默降级 —— 日志是辅助，不是主流程。
//   · **按大小轮转**：默认 1MB × 3 份。常驻托盘的应用一开就是几天，不轮转会无限长大。
//   · 纯逻辑（行格式化、轮转判定、轮转后的文件名）单独导出，便于单测。

const fs = require("fs");
const path = require("path");

/** 单个日志文件的上限（字节） */
const MAX_BYTES = 1024 * 1024;
/** 保留份数（含当前文件） */
const MAX_FILES = 3;

/** 两位补零 */
function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** 时间戳：`2026-09-18 10:20:31.123` */
function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** 一行日志文本（末尾带换行，便于直接 append） */
function formatLine(level, message, d = new Date()) {
  return `${stamp(d)} [${level}] ${message}\n`;
}

/** 轮转后的文件名：index 0 是当前文件，1 是上一个，依此类推 */
function rotatedName(base, index) {
  return index === 0 ? base : `${base}.${index}`;
}

/**
 * 要不要轮转。
 * 当前文件为空时不轮转（否则刚好写满后再写一条会立刻转出一个空档）。
 */
function shouldRotate(currentBytes, incomingBytes, maxBytes = MAX_BYTES) {
  return currentBytes > 0 && currentBytes + incomingBytes > maxBytes;
}

/** 把多行文本拆成逐行（后端 stderr 一次可能来好几行，逐行加时间戳更好读） */
function splitLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
}

/**
 * 建一个 logger。
 *
 * @param {string} dir 日志目录（通常是 `<数据根>/logs`）
 * @param {{name?: string, maxBytes?: number, maxFiles?: number, echo?: boolean}} opts
 *   `echo` 为真时同时打到 console（开发时方便，打包后 console 没人看，默认关）
 */
function createLogger(dir, opts = {}) {
  const baseName = opts.name || "app.log";
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const maxFiles = opts.maxFiles || MAX_FILES;
  const echo = !!opts.echo;

  let ready = false;
  let failed = false;

  /** 确保目录存在；失败就标记不可用，后续全部静默 */
  function ensure() {
    if (ready || failed) return ready;
    try {
      fs.mkdirSync(dir, { recursive: true });
      ready = true;
    } catch (_) {
      failed = true;
    }
    return ready;
  }

  function filePath(index = 0) {
    return path.join(dir, rotatedName(baseName, index));
  }

  function sizeOf(p) {
    try {
      return fs.statSync(p).size;
    } catch (_) {
      return 0;
    }
  }

  /** 轮转：最老的删掉，其余依次后移，当前文件腾空 */
  function rotate() {
    try {
      const oldest = filePath(maxFiles - 1);
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let i = maxFiles - 2; i >= 0; i--) {
        const from = filePath(i);
        if (fs.existsSync(from)) fs.renameSync(from, filePath(i + 1));
      }
    } catch (_) {
      /* 轮转失败不算致命：下一次写入会继续追加，顶多文件超出上限 */
    }
  }

  function write(level, message) {
    if (!ensure()) return;
    const line = formatLine(level, message);
    const bytes = Buffer.byteLength(line);
    try {
      if (shouldRotate(sizeOf(filePath(0)), bytes, maxBytes)) rotate();
      fs.appendFileSync(filePath(0), line, "utf8");
    } catch (_) {
      /* 写不进去就算了，绝不向上抛 */
    }
    if (echo) {
      // eslint-disable-next-line no-console
      (level === "error" ? console.error : console.log)(line.trimEnd());
    }
  }

  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
    /** 把一段可能含多行的文本逐行记下（后端的 traceback 就是这样） */
    block: (level, text) => {
      for (const l of splitLines(text)) write(level, l);
    },
    path: () => filePath(0),
    dir: () => dir,
    /** 供自检用：当前文件已写多少字节 */
    size: () => sizeOf(filePath(0)),
  };
}

/**
 * 后端 stderr 的每一行该记成什么级别。
 *
 * ⚠️ 不能「stderr 一律记成 error」：Flask 把**启动横幅和访问日志也写到 stderr**
 * （`* Serving Flask app` / `GET /api/hello 200`），一律标 error 会让日志里
 * 满屏红字，真正出问题的那几行反而被淹掉 —— 日志就白记了。
 */
const BACKEND_ERROR_HINT =
  /traceback|exception|error|critical|fatal|failed|refused|timed out|no such file|permission denied/i;

function levelForBackendLine(line) {
  return BACKEND_ERROR_HINT.test(String(line)) ? "error" : "info";
}

module.exports = {
  createLogger,
  formatLine,
  stamp,
  rotatedName,
  shouldRotate,
  splitLines,
  levelForBackendLine,
  MAX_BYTES,
  MAX_FILES,
};
