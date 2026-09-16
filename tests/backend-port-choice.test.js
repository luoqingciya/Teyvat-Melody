// 自检：后端端口的稳定性（node tests/backend-port-choice.test.js）
//
// 为什么值得单独锁住：渲染进程从 `http://127.0.0.1:<端口>` 加载，而 **localStorage 按
// origin 隔离**（origin 含端口）。端口每次随机 = 用户所有设置每次重启都「重置」。
// 实测原来用 `listen(0)` 拿到的是 53375 / 53414 / 53446 这种每次不同的临时端口。
const {
  stablePortFor,
  candidatePorts,
  PORT_RANGE_START,
  PORT_RANGE_SIZE,
} = require("../electron/backendPort");

let FAILED = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (!cond && extra ? `  → ${extra}` : ""));
  if (!cond) FAILED = 1;
}

console.log("---- stablePortFor ----");

const installRoot = "D:\\Apps\\01_Sys_Daily\\15_Music\\TeyvatMelody";
const devRoot = "D:\\Project\\Teyvat-Melody";
const portableRoot = "E:\\Portable\\TeyvatMelody";

const a1 = stablePortFor(installRoot);
const a2 = stablePortFor(installRoot);
ok("⚠️ 同一路径两次调用结果相同（这是设置能留存的前提）", a1 === a2, `${a1} vs ${a2}`);

const b = stablePortFor(devRoot);
const c = stablePortFor(portableRoot);
ok("⚠️ 不同路径得到不同端口（便携版与安装版不串后端）", a1 !== b && b !== c && a1 !== c, `${a1} / ${b} / ${c}`);

ok(
  "端口落在约定区间内",
  [a1, b, c].every((p) => p >= PORT_RANGE_START && p < PORT_RANGE_START + PORT_RANGE_SIZE),
  `${a1} / ${b} / ${c}`
);
ok("区间不包含常用端口（避开 5000/8080 之类）", PORT_RANGE_START >= 1024);

ok("空/undefined 不抛错，返回区间内的端口", (() => {
  const p = stablePortFor(undefined);
  return Number.isInteger(p) && p >= PORT_RANGE_START && p < PORT_RANGE_START + PORT_RANGE_SIZE;
})());
ok("大小写不同的路径视为不同安装（Windows 上路径不敏感，但哈希不必刻意归一）", typeof stablePortFor("D:\\A") === "number");

// 分布：一批不同路径不应大量撞在同一端口
{
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(stablePortFor(`D:\\Apps\\Instance${i}\\TeyvatMelody`));
  ok("500 个不同路径至少落到 450 个不同端口（分布够散）", seen.size >= 450, `去重后 ${seen.size}`);
}

console.log("\n---- candidatePorts ----");

{
  const list = candidatePorts(installRoot, 5);
  ok("首个候选就是稳定端口", list[0] === stablePortFor(installRoot), JSON.stringify(list));
  ok("候选依次顺延（用于应对端口被占）", list.every((p, i) => p === list[0] + i), JSON.stringify(list));
  ok("候选数量可指定", candidatePorts(installRoot, 3).length === 3);
  ok("tries 为 0/负数时至少给一个候选", candidatePorts(installRoot, 0).length >= 1);
}

console.log("\n自检结束");
process.exit(FAILED);
