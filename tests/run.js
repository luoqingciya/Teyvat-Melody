// 统一测试入口：串行运行 tests/*.test.js，任一文件失败则整体失败。
// 用法：node tests/run.js   （Python 侧另由 tests/online-proxy.test.py 承担）
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

if (!files.length) {
  console.error("未找到任何 *.test.js");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  console.log(`\n===== ${f} =====`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} 个测试文件通过`);
process.exit(failed ? 1 : 0);
