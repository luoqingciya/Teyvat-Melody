// 统一测试入口：串行运行 tests/*.test.js，任一文件失败则整体失败。
// 用法：node tests/run.js   （Python 侧另由 tests/online-proxy.test.py 承担）
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

if (!files.length) {
  console.error("未找到任何 *.test.js");
  process.exit(1);
}

// 用 ESM loader 把前端的 `@/` 别名补上（Node 原生不认 Vite 的别名）。
// 这样测试可以直接 import 真实的 store，而不必为测试改生产代码的导入写法。
// 见 tests/alias-loader.mjs 的说明。
const aliasRegister = path.join(dir, "register-alias.mjs");

let failed = 0;
const crashed = [];
for (const f of files) {
  console.log(`\n===== ${f} =====`);
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(aliasRegister).href, path.join(dir, f)], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    failed++;
    // 区分「断言失败」和「文件根本没跑起来」：后者没有 FAIL 行，只体现为计数少 1，
    // 在 CI 日志里极难定位（曾因缺 frontend 依赖、import 阶段 ERR_MODULE_NOT_FOUND
    // 而表现为「9/10 个测试文件通过」却找不到任何 FAIL）。这里单独点出来。
    if (r.status === null || r.signal) {
      crashed.push(`${f}（被信号 ${r.signal || "?"} 终止）`);
    } else {
      crashed.push(`${f}（退出码 ${r.status}）`);
    }
  }
}

if (crashed.length) {
  console.log("\n⚠️ 以下测试文件未正常结束（非断言失败，多为 import/启动阶段报错）：");
  for (const c of crashed) console.log(`   · ${c}`);
}

console.log(`\n${files.length - failed}/${files.length} 个测试文件通过`);
process.exit(failed ? 1 : 0);
