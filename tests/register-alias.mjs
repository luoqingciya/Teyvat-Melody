// 测试用入口：把 `@/` 别名 loader 注册进 Node 的模块解析流程。
//
// 为什么需要这一层：`--import <loader.mjs>` 直接指向一个导出了 `resolve` 的文件
// **并不会**生效 —— Node 要求用 `module.register()` 显式注册 hooks 文件，
// 或在 `--experimental-loader` 下运行。这里用 `register()`（Node 20.6+ 稳定 API），
// 不依赖实验性开关。真正的解析逻辑在同目录 `alias-loader.mjs`。
//
// 用法（见 tests/run.js）：
//   node --import ./tests/register-alias.mjs tests/xxx.test.js
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-loader.mjs", pathToFileURL(`${import.meta.dirname}/`));
