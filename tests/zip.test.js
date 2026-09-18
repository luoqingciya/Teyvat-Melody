// 自检：ZIP 读写（node tests/zip.test.js）
//
// ⚠️ 这是自己实现的格式，所以**不能只做「自己写、自己读」的往返** ——
// 那样两边犯同一个错也会互相通过。必须让**系统自带的解压工具**来验：
//   · Windows 10+ 自带 bsdtar（`tar -tf` 能列 zip）
//   · PowerShell 的 Expand-Archive 也能解
// 备份包是要交给用户长期保存的，格式写错等于备份是废的。
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createZip, readZip, crc32 } = require("../electron/zip");

let FAILED = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (!cond && extra ? `  → ${extra}` : ""));
  if (!cond) FAILED = 1;
}

console.log("---- CRC-32 ----");
ok("已知值：'123456789' → 0xCBF43926", crc32(Buffer.from("123456789")) === 0xcbf43926, crc32(Buffer.from("123456789")).toString(16));
ok("空数据 → 0", crc32(Buffer.alloc(0)) === 0);
ok("同样输入结果稳定", crc32(Buffer.from("abc")) === crc32(Buffer.from("abc")));
ok("不同输入结果不同", crc32(Buffer.from("abc")) !== crc32(Buffer.from("abd")));

console.log("\n---- 自往返 ----");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teyvat-zip-"));
{
  const entries = [
    { name: "data/library.db", data: Buffer.from("假装是数据库内容") },
    { name: "cache/config.json", data: Buffer.from('{"proxy":{"enabled":false}}') },
    { name: "sources/我的音源.js", data: Buffer.from("// 中文文件名 + 中文内容\nmodule.exports = {}") },
    { name: "empty.txt", data: Buffer.alloc(0) },
    { name: "settings/", data: Buffer.alloc(0) },
  ];
  const zip = createZip(entries, new Date(2026, 8, 18, 11, 0, 0));
  const back = readZip(zip);
  ok("条目数一致", back.length === entries.length, `${back.length} vs ${entries.length}`);
  const byName = Object.fromEntries(back.map((e) => [e.name, e]));
  ok("⚠️ 中文文件名能还原", !!byName["sources/我的音源.js"], Object.keys(byName).join(", "));
  ok("⚠️ 中文内容逐字节一致", byName["sources/我的音源.js"].data.toString("utf8").includes("中文内容"));
  ok("二进制内容逐字节一致", byName["data/library.db"].data.equals(Buffer.from("假装是数据库内容")));
  ok("空文件能还原且长度为 0", byName["empty.txt"].data.length === 0);
  ok("目录条目被识别为目录", byName["settings/"].dir === true);
  ok("普通条目不是目录", byName["data/library.db"].dir === false);

  // 随机二进制（覆盖各种字节值，防止 UTF-8 假设混进来）
  const rnd = Buffer.alloc(4096);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 7 + 13) % 256;
  const zip2 = createZip([{ name: "blob.bin", data: rnd }]);
  ok("⚠️ 随机二进制逐字节一致", readZip(zip2)[0].data.equals(rnd));
}

console.log("\n---- 坏输入不该崩 ----");
ok("太短的 buffer 会报错而不是崩", (() => { try { readZip(Buffer.from("xx")); return false; } catch { return true; } })());
ok("不是 zip 的 buffer 会报错", (() => {
  try { readZip(Buffer.alloc(100, 7)); return false; } catch (e) { return /合法的 zip/.test(e.message); }
})());

console.log("\n---- 交给系统工具验证（关键）----");
{
  const dir = path.join(tmp, "external");
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, "backup.zip");
  const payload = {
    "data/library.db": "SQLite format 3\u0000fake",
    "cache/config.json": '{"proxy":{"enabled":true,"host":"127.0.0.1","port":7890}}',
    "sources/test-source.js": "// hello from the backup",
  };
  fs.writeFileSync(
    zipPath,
    createZip(Object.entries(payload).map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })))
  );

  // ① bsdtar（Windows 10+ 自带）能否列出内容
  let listed = "";
  try {
    listed = execFileSync("tar", ["-tf", zipPath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    listed = "";
    console.log("  （tar 不可用，跳过这一项）", e.message);
  }
  if (listed) {
    ok("⚠️ 系统 tar 能列出备份包内容", /data\/library\.db/.test(listed), listed.replace(/\n/g, " "));
    ok("tar 列出的条目数与写入一致", listed.trim().split("\n").length === 3, listed.replace(/\n/g, " "));
  }

  // ② PowerShell Expand-Archive 能否真正解出来（内容要对）
  const outDir = path.join(tmp, "expanded");
  let expanded = false;
  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    expanded = true;
  } catch (e) {
    console.log("  （Expand-Archive 失败）", String(e.stderr || e.message).slice(0, 200));
  }
  if (expanded) {
    const cfg = path.join(outDir, "cache", "config.json");
    ok("⚠️ 系统工具解出来的文件存在", fs.existsSync(cfg), cfg);
    ok(
      "⚠️ 解出来的内容与写入一致",
      fs.existsSync(cfg) && fs.readFileSync(cfg, "utf8") === payload["cache/config.json"],
      fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8").slice(0, 60) : "(无文件)"
    );
    ok("子目录结构被保留", fs.existsSync(path.join(outDir, "sources", "test-source.js")));
  } else {
    ok("系统工具解压验证", false, "Expand-Archive 没能解出内容");
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n自检结束");
process.exit(FAILED);
