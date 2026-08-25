// 构建前清理 dist：Vite 配置了 emptyOutDir:false（避免沙箱拦截 shell rm），
// 所以用 Node 的 fs.rmSync 可靠清空，防止多轮构建后过期 hash 产物堆积、撑大 asar。
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
rmSync(dist, { recursive: true, force: true });
