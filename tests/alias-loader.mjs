// 让 Node 也能解析前端的 `@/` 路径别名，便于**直接 import 前端 store 做单元测试**。
//
// 背景：`@/` 是 Vite 在 `frontend/vite.config.js` 里配的别名，Node 原生不认识。
// 于是 tests/ 里想测一个真实 store，就会撞上
// `ERR_MODULE_NOT_FOUND: Cannot find package '@/composables'`。
//
// 为什么不在 store 里改成相对路径：store 之间互相引用、以及 components 引用 store，
// 全项目都用 `@/`，为测试单独改一种写法会破坏一致性（且改动面很大）。
// 所以这里用官方支持的 **ESM loader hook** 在测试进程里把别名补上，
// 生产代码零改动。用法见 tests/run.js（通过 `--import` 注册）。
//
// ⚠️ 这个文件只服务测试，不参与打包。
import { pathToFileURL } from "url";
import path from "path";
import fs from "fs";

// tests/ 的上一级就是项目根；前端源码根为 <root>/frontend/src
const ROOT = path.resolve(import.meta.dirname, "..");
const SRC_ROOT = path.join(ROOT, "frontend", "src");
/** 前端的依赖装在这里；tests/ 目录本身没有 node_modules，所以裸包名要重定向过去 */
const FE_MODULES = path.join(ROOT, "frontend", "node_modules");

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 把裸包名（vue / pinia / ...）解析到 frontend/node_modules。
 * 为什么不靠 Node 默认向上查找：测试文件在 <root>/tests/，
 * 而依赖在 <root>/frontend/node_modules，默认查找路径里没有它。
 */
function resolveFromFrontend(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  // 取包名（支持 @scope/name 与子路径 name/sub）
  const seg = specifier.split("/");
  const pkgName = specifier.startsWith("@") ? seg.slice(0, 2).join("/") : seg[0];
  const pkgDir = path.join(FE_MODULES, pkgName);
  if (!isDir(pkgDir)) return null;

  // 子路径：<pkg>/sub/path → 直接指向文件
  if (pkgName !== specifier) {
    const sub = path.join(FE_MODULES, specifier);
    if (isFile(sub)) return sub;
    if (isFile(`${sub}.js`)) return `${sub}.js`;
    if (isDir(sub) && isFile(path.join(sub, "index.js"))) return path.join(sub, "index.js");
    return null;
  }

  // 包主入口：读 package.json 的 exports / module / main
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const ex = pj.exports;
    let entry = null;
    if (typeof ex === "string") entry = ex;
    else if (ex && typeof ex === "object") {
      const dot = ex["."];
      if (typeof dot === "string") entry = dot;
      else if (dot && typeof dot === "object") entry = dot.import || dot.module || dot.default || dot.require;
    }
    entry = entry || pj.module || pj.main || "index.js";
    const target = path.join(pkgDir, entry);
    if (isFile(target)) return target;
  } catch {
    /* 读不到就交给 Node 默认流程 */
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@" || specifier.startsWith("@/")) {
    const rel = specifier === "@" ? "" : specifier.slice(2);
    const target = path.join(SRC_ROOT, rel);
    // 没写扩展名时补全：先试 <path>.js，再试 <path>/index.js
    let resolved = target;
    if (!path.extname(target)) {
      resolved = isFile(`${target}.js`) ? `${target}.js` : path.join(target, "index.js");
    }
    return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }

  const fromFe = resolveFromFrontend(specifier);
  if (fromFe) return { url: pathToFileURL(fromFe).href, shortCircuit: true };

  return nextResolve(specifier, context);
}

