// 自检：落盘日志（node tests/logger.test.js）
//
// 为什么值得单独测：日志是「出问题时唯一能拿到的现场」，它自己坏掉是**静默**的
//（没人会盯着日志文件看）。轮转尤其容易写错 —— 写错了要么无限长大，要么把最新的一份删掉。
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createLogger,
  formatLine,
  stamp,
  rotatedName,
  shouldRotate,
  splitLines,
  levelForBackendLine,
  MAX_FILES,
} = require("../electron/logger");

let FAILED = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (!cond && extra ? `  → ${extra}` : ""));
  if (!cond) FAILED = 1;
}

console.log("---- 纯逻辑 ----");
{
  const d = new Date(2026, 8, 18, 10, 20, 31, 123); // 2026-09-18 10:20:31.123
  ok("时间戳格式与补零", stamp(d) === "2026-09-18 10:20:31.123", stamp(d));
  ok("行格式：时间 + 级别 + 内容", formatLine("error", "炸了", d) === "2026-09-18 10:20:31.123 [error] 炸了\n");
  ok("行尾带换行（append 时不用再补）", formatLine("info", "x", d).endsWith("\n"));
}
ok("rotatedName：0 是当前文件本身", rotatedName("app.log", 0) === "app.log");
ok("rotatedName：1 是上一个", rotatedName("app.log", 1) === "app.log.1");

ok("⚠️ 空文件不轮转（否则刚好写满会立刻转出一个空档）", shouldRotate(0, 999, 100) === false);
ok("未超上限不轮转", shouldRotate(50, 40, 100) === false);
ok("⚠️ 超上限要轮转", shouldRotate(90, 20, 100) === true);
ok("恰好等于上限不轮转", shouldRotate(80, 20, 100) === false);

ok("splitLines 拆多行", splitLines("a\nb\r\nc").length === 3);
ok("splitLines 丢掉空行", splitLines("a\n\n\nb").length === 2, JSON.stringify(splitLines("a\n\n\nb")));
ok("splitLines 处理空输入", splitLines("").length === 0);

console.log("\n---- 后端日志的级别判定 ----");
ok("⚠️ Flask 启动横幅不算 error", levelForBackendLine(" * Serving Flask app 'app.server'") === "info");
ok("⚠️ 访问日志不算 error", levelForBackendLine('127.0.0.1 - - "GET /api/hello HTTP/1.1" 200 -') === "info");
ok("真正的 traceback 记 error", levelForBackendLine("Traceback (most recent call last):") === "error");
ok("异常行记 error", levelForBackendLine("ValueError: boom") === "error");
ok("Failed 记 error", levelForBackendLine("Failed to bind port") === "error");
ok("空行不炸", typeof levelForBackendLine("") === "string");

console.log("\n---- 实际写盘 ----");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teyvat-log-"));

{
  const log = createLogger(path.join(tmp, "basic"));
  log.info("第一条");
  log.warn("第二条");
  log.error("第三条");
  const text = fs.readFileSync(log.path(), "utf8");
  ok("文件被创建", fs.existsSync(log.path()));
  ok("三条都写进去了", text.split("\n").filter(Boolean).length === 3, JSON.stringify(text));
  ok("带级别标记", /\[info\] 第一条/.test(text) && /\[warn\] 第二条/.test(text) && /\[error\] 第三条/.test(text));
  ok("目录不存在会自动建", fs.existsSync(path.join(tmp, "basic")));
  ok("dir() 返回目录", log.dir() === path.join(tmp, "basic"));
}

{
  const log = createLogger(path.join(tmp, "block"));
  log.block("error", "Traceback (most recent call last):\n  File \"a.py\", line 1\nValueError: boom\n");
  const lines = fs.readFileSync(log.path(), "utf8").split("\n").filter(Boolean);
  ok("多行文本逐行记录（traceback 可读）", lines.length === 3, JSON.stringify(lines));
  ok("每行都带时间戳与级别", lines.every((l) => /\[error\]/.test(l)));
}

{
  // 轮转：上限压到很小，写足够多条
  const dir = path.join(tmp, "rotate");
  const log = createLogger(dir, { maxBytes: 300, maxFiles: 3 });
  for (let i = 0; i < 60; i++) log.info(`第 ${i} 行填充填充填充填充填充填充填充填充`);
  const files = fs.readdirSync(dir).sort();
  ok("轮转产生的份数不超过上限", files.length <= 3, JSON.stringify(files));
  ok("当前文件是 app.log", files.includes("app.log"), JSON.stringify(files));
  ok("生成了 .1 备份", files.includes("app.log.1"), JSON.stringify(files));
  ok(
    "⚠️ 最老的一份被删掉（不是把最新的删了）",
    !files.includes(`app.log.${MAX_FILES - 1}`) || files.length === MAX_FILES,
    JSON.stringify(files)
  );
  const newest = fs.readFileSync(path.join(dir, "app.log"), "utf8");
  ok("⚠️ 最新内容留在 app.log 里（轮转没把新日志转走）", /第 59 行/.test(newest), newest.slice(-80));
}

{
  // 不该抛错：路径被一个文件占住，建不出目录
  const blocked = path.join(tmp, "blocked");
  fs.writeFileSync(blocked, "我是文件不是目录");
  const log = createLogger(path.join(blocked, "logs"));
  let threw = false;
  try {
    log.info("写不进去也不该抛");
    log.error("再来一条");
    log.block("error", "多行\n也不该抛");
  } catch (e) {
    threw = true;
  }
  ok("⚠️ 目录建不出来时静默降级、绝不抛错", threw === false);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n自检结束");
process.exit(FAILED);
