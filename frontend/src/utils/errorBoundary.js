// 渲染进程的全局错误兜底。
//
// ⚠️ 没有它的话：Vue 渲染期报错 → 界面直接坏掉，而且**什么都不记录**。
// 打包后的应用没有控制台，用户能告诉你的只有「界面白了 / 点了没反应」。
// 现在统一报给主进程写进日志（<数据根>/logs/app.log），设置页里能直接打开那个目录。
import { toastError } from "@/utils/toast";

const bridge = () => window.pywebview?.api;

// 同一个错误短时间重复出现时只提示一次 —— 渲染期错误往往是「每帧都报」，
// 不压一下会把提示刷屏，反而让用户看不到别的信息。日志仍然每条都记。
const DEDUP_MS = 5000;
const recent = new Map();

function shouldToast(key) {
  const now = Date.now();
  const last = recent.get(key) || 0;
  if (now - last < DEDUP_MS) return false;
  recent.set(key, now);
  // 顺手清理过期项，避免长期运行后 Map 无限长大
  if (recent.size > 50) {
    for (const [k, t] of recent) if (now - t > DEDUP_MS) recent.delete(k);
  }
  return true;
}

/** 把错误消息整理成一行可读文本 */
function describe(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  if (err.message) return `${err.name || "Error"}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 上报一个错误。
 *
 * @param {string} kind 来源标记（vue / window / promise），方便在日志里区分
 * @param {*} err 错误对象或任意值
 * @param {string} [info] 附加上下文（Vue 会给出「在哪个生命周期/渲染阶段」）
 */
export function reportError(kind, err, info) {
  const text = describe(err);
  const message = info ? `[${kind}] ${text} (${info})` : `[${kind}] ${text}`;
  console.error(message, err);

  try {
    bridge()?.reportError?.({ level: "error", message, stack: err && err.stack });
  } catch {
    /* 上报本身失败就算了，不能因为记录错误而再抛一个错误 */
  }

  if (shouldToast(text)) {
    toastError(`出错了：${text.slice(0, 120)}（详情见日志）`);
  }
}

/** 装上三类全局兜底。只装一次。 */
let installed = false;
export function installErrorBoundary(app) {
  if (installed) return;
  installed = true;

  // Vue 组件内抛出的错误（渲染、生命周期、watcher、事件处理）
  app.config.errorHandler = (err, _instance, info) => reportError("vue", err, info);

  // 未被任何 try/catch 接住的同步错误
  window.addEventListener("error", (e) => {
    // 资源加载失败（img/script）也会走这里，没有 error 对象，单独描述一下
    if (e.error) reportError("window", e.error);
    else if (e.target && e.target !== window) reportError("window", `资源加载失败: ${e.target.src || e.target.href || e.target.tagName}`);
  });

  // 未处理的 Promise 拒绝（异步代码里最常见的一类漏网之鱼）
  window.addEventListener("unhandledrejection", (e) => {
    reportError("promise", e.reason);
  });
}
