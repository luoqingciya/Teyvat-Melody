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

/**
 * 找一个可用的 Python 解释器（用来做「独立实现」验证）。
 * 优先项目 venv，其次 PATH 上的 python3/python —— CI 在 ubuntu 上，只有后者。
 */
function findPython() {
  const cands = [
    process.env.PYTHON,
    path.join(__dirname, "..", ".venv", "Scripts", "python.exe"),
    path.join(__dirname, "..", ".venv", "bin", "python"),
    "python3",
    "python",
  ].filter(Boolean);
  for (const c of cands) {
    try {
      execFileSync(c, ["-c", "import zipfile"], { stdio: "ignore" });
      return c;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}


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

console.log("\n---- 用「别的实现」验证（关键）----");
{
  // ⚠️ 必须用**独立实现**来验，不能只做「自己写、自己读」的往返 ——
  //    那样两边犯同一个错也会互相通过。
  // ⚠️⚠️ 也别依赖某个平台的工具：CI 在 ubuntu 上跑，Windows 自带的 Expand-Archive 根本不存在
  //    （第一版就是这么挂的：本地全绿、CI 直接红）。改用 **Python 的 zipfile** ——
  //    跨平台、本项目必然有 Python、而且是另一套完全独立的实现。
  const dir = path.join(tmp, "external");
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, "backup.zip");
  const payload = {
    "data/library.db": "SQLite format 3\u0000fake",
    "cache/config.json": '{"proxy":{"enabled":true,"host":"127.0.0.1","port":7890}}',
    "sources/test-source.js": "// hello from the backup",
    "sources/中文名.js": "// 中文文件名",
  };
  fs.writeFileSync(
    zipPath,
    createZip(Object.entries(payload).map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })))
  );

  const py = findPython();
  ok("⚠️ 找到了 Python（独立验证要用它）", !!py, "没找到 python，无法做独立验证");

  if (py) {
    // ① 列内容
    let listed = "";
    try {
      listed = execFileSync(py, ["-m", "zipfile", "-l", zipPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (e) {
      console.log("  列目录失败:", String(e.stderr || e.message).slice(0, 200));
    }
    ok("⚠️ 独立实现能读出条目名", /data\/library\.db/.test(listed), listed.replace(/\n/g, " ").slice(0, 200));
    ok(
      "⚠️ 独立实现能读出中文文件名（UTF-8 标记生效）",
      /中文名\.js/.test(listed),
      listed.replace(/\n/g, " ").slice(0, 200)
    );

    // ② 真正解出来并逐字节比对
    const outDir = path.join(tmp, "expanded");
    let extracted = false;
    try {
      execFileSync(py, ["-m", "zipfile", "-e", zipPath, outDir], { stdio: ["ignore", "ignore", "pipe"] });
      extracted = true;
    } catch (e) {
      console.log("  解压失败:", String(e.stderr || e.message).slice(0, 200));
    }
    ok("独立实现能解开全部内容", extracted);
    if (extracted) {
      for (const [name, text] of Object.entries(payload)) {
        const f = path.join(outDir, name);
        const got = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
        ok(`⚠️ 解出的「${name}」内容一致`, got === text, got === null ? "(文件不存在)" : got.slice(0, 60));
      }
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n自检结束");
process.exit(FAILED);
