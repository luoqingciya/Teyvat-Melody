// 自检：备份的收集与恢复（node tests/backup.test.js）
//
// 备份功能的价值全在「恢复时真的能把东西拿回来」，所以这里重点测：
//   · 该收的收到了、不该收的没进去（music/ 和音频缓存不能进）
//   · 恢复能还原内容
//   · ⚠️ 目录穿越（`../`）会被拒绝 —— 备份包可能是别人给的，不能写到数据根外面
//   · 不是本软件的包 / 格式过新 → 明确拒绝，而不是「恢复一半」
const fs = require("fs");
const os = require("os");
const path = require("path");
const backup = require("../electron/backup");
const { createZip } = require("../electron/zip");

let FAILED = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (!cond && extra ? `  → ${extra}` : ""));
  if (!cond) FAILED = 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "teyvat-backup-"));
const mk = (root, rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

console.log("---- 收集 ----");
const root = path.join(tmp, "root");
mk(root, "data/library.db", "SQLITE-CONTENT");
mk(root, "data/sub/extra.bin", Buffer.from([1, 2, 3]));
mk(root, "cache/config.json", '{"proxy":{"enabled":false}}');
mk(root, "cache/audio/big.mp3", "音频缓存不该进备份");
mk(root, "sources/my-source.js", "// source");
mk(root, "sources/sources.json", "[]");
mk(root, "music/song.mp3", "用户自己的歌不该进备份");
mk(root, "logs/app.log", "日志不该进备份");

const r = backup.collect(root, { settings: { theme: "liyue", fsFontSize: 22 }, appVersion: "9.9.9" });
const names = r.entries.map((e) => e.name);
console.log("  收进备份:", names.join(", "));

ok("收到曲库", names.includes("data/library.db"));
ok("收到子目录文件", names.includes("data/sub/extra.bin"));
ok("收到跨进程配置", names.includes("cache/config.json"));
ok("收到源脚本", names.includes("sources/my-source.js"));
ok("收到源启用状态", names.includes("sources/sources.json"));
ok("收到渲染进程设置", names.includes("settings.json"));
ok("带上了清单", names.includes(backup.MANIFEST));
ok("⚠️ 不含音频缓存", !names.some((n) => n.includes("cache/audio")), names.join(", "));
ok("⚠️ 不含用户音乐文件", !names.some((n) => n.startsWith("music/")), names.join(", "));
ok("⚠️ 不含日志", !names.some((n) => n.startsWith("logs/")), names.join(", "));
ok("路径用正斜杠（zip 要求）", names.every((n) => !n.includes("\\")), names.join(", "));
ok("files/bytes 统计有值", r.files > 0 && r.bytes > 0, JSON.stringify({ f: r.files, b: r.bytes }));

console.log("\n---- 检查与恢复 ----");
const zipBuf = backup.createZip(r.entries);
{
  const info = backup.inspect(zipBuf);
  ok("能识别自己的备份包", info.ok === true, JSON.stringify(info));
  ok("清单里带版本与时间", info.ok && info.manifest.version === "9.9.9" && !!info.manifest.createdAt, JSON.stringify(info.manifest));
  ok("列出了文件清单", info.ok && info.files.length === r.entries.length, `${info.files?.length}`);
}
{
  // 恢复到另一个「新安装」的数据根
  const fresh = path.join(tmp, "fresh");
  fs.mkdirSync(fresh, { recursive: true });
  const res = backup.apply(fresh, zipBuf);
  ok("恢复没有失败项", res.failed.length === 0, JSON.stringify(res.failed));
  ok("⚠️ 曲库内容被还原", fs.readFileSync(path.join(fresh, "data/library.db"), "utf8") === "SQLITE-CONTENT");
  ok("⚠️ 二进制文件被还原", fs.readFileSync(path.join(fresh, "data/sub/extra.bin")).equals(Buffer.from([1, 2, 3])));
  ok("源脚本被还原", fs.readFileSync(path.join(fresh, "sources/my-source.js"), "utf8") === "// source");
  ok("配置被还原", fs.readFileSync(path.join(fresh, "cache/config.json"), "utf8").includes("enabled"));
  const settings = JSON.parse(fs.readFileSync(path.join(fresh, "settings.json"), "utf8"));
  ok("渲染进程设置被还原", settings.theme === "liyue" && settings.fsFontSize === 22, JSON.stringify(settings));
  ok("清单本身不写回数据根", !fs.existsSync(path.join(fresh, backup.MANIFEST)));
}

console.log("\n---- 拒绝坏包 / 危险包 ----");
{
  const notMine = createZip([{ name: "hello.txt", data: Buffer.from("hi") }]);
  const info = backup.inspect(notMine);
  ok("⚠️ 不是本软件的包 → 明确拒绝", info.ok === false && /清单/.test(info.message), JSON.stringify(info));
}
{
  const tooNew = createZip([
    { name: backup.MANIFEST, data: Buffer.from(JSON.stringify({ format: 99 })) },
  ]);
  const info = backup.inspect(tooNew);
  ok("⚠️ 格式过新 → 明确拒绝（而不是恢复一半）", info.ok === false && /更新的版本/.test(info.message), JSON.stringify(info));
}
{
  const evil = createZip([
    { name: backup.MANIFEST, data: Buffer.from(JSON.stringify({ format: 1 })) },
    { name: "../escaped.txt", data: Buffer.from("不该写到数据根外面") },
    { name: "data/ok.txt", data: Buffer.from("正常文件") },
  ]);
  const sandbox = path.join(tmp, "sandbox");
  fs.mkdirSync(sandbox, { recursive: true });
  const res = backup.apply(sandbox, evil);
  ok("⚠️ 目录穿越被拒绝", res.failed.some((f) => /越界/.test(f)), JSON.stringify(res));
  ok("⚠️ 越界文件确实没被写出去", !fs.existsSync(path.join(tmp, "escaped.txt")), "被写到了数据根外面");
  ok("同一包里的正常文件照常恢复", fs.existsSync(path.join(sandbox, "data/ok.txt")));
}

console.log("\n---- 文件名 ----");
{
  const n = backup.defaultFileName("1.0.23", new Date(2026, 8, 18));
  ok("默认文件名带日期", /^TeyvatMelody-备份-20260918-v1\.0\.23\.zip$/.test(n), n);
  ok("不带版本号也能用", /\.zip$/.test(backup.defaultFileName("", new Date(2026, 0, 2))));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n自检结束");
process.exit(FAILED);
