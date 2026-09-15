// appConfig：主进程读取用户配置（与后端共享 `<数据根>/cache/config.json`）。
//
// 为什么要有这个文件：渲染进程的配置存在 localStorage（`teyvat-melody:config`），
// 主进程和后端**都读不到**。所以需要跨进程的配置一律落文件。现成通道就是
// `cache/config.json`（后端 `app/services/online_cache.py` 在读写它，主进程也直接读）。
//
// ⚠️ 后端的 `save_config()` 是**白名单**实现：只处理它认识的键。往这里加新配置项时，
// 必须同步改 `online_cache.py` 的 `save_config()`，否则设置页写进去会被静默丢掉。
const fs = require("fs");
const path = require("path");

let _root = null;

/** 由 main.js 在选定数据根目录后注入（dataRoot 依赖 app，属于 Electron 侧）。 */
function setDataRoot(root) {
  _root = root;
}

function configPath() {
  if (!_root) return null;
  return path.join(_root, "cache", "config.json");
}

/**
 * 读整个配置文件。**永不抛错**：文件不存在/损坏/JSON 非法都返回 {}，
 * 调用方各自取默认值（比让一个坏文件把启动流程炸掉好得多）。
 */
function readConfig() {
  const p = configPath();
  if (!p) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 读代理配置（已归一化）。主进程每次要联网前调一次即可 ——
 * 文件很小，读一次比维护「配置变了要通知谁」的缓存失效逻辑简单可靠得多。
 */
function proxyConfig() {
  const { normalizeProxy } = require("./proxy");
  return normalizeProxy(readConfig().proxy);
}

module.exports = { setDataRoot, configPath, readConfig, proxyConfig };
