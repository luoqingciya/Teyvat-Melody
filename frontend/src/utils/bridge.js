// 调用主进程桥接（window.pywebview.api）前的参数处理。
//
// ⚠️ 关键约束：`contextBridge` 暴露的函数，在「渲染进程主世界 → preload 隔离世界」跨边界时
// 就会用**结构化克隆**复制参数 —— 这一步发生在 preload 代码执行之前。
// 因此：
//   - Vue 的 reactive 对象是 Proxy，无法被克隆 → 调用直接抛
//     "An object could not be cloned."，界面表现为莫名的「操作失败」；
//   - **在 preload 里做深拷贝救不了它**（那时参数已经过不了边界了），必须在调用侧处理。
//
// 所以：凡是要给桥接方法传**非原始值**（对象 / 数组），一律先经 toPlain() 转成普通值。
// 项目既有的 desktopLyricsBridge / miniModeBridge 也是这么做的。
//
// 边界说明（两道，别搞混）：
//   1) 主世界 → 隔离世界：由本文件负责（调用侧去 reactive）
//   2) 隔离世界 → 主进程：由 preload 的 invoke 统一深拷贝负责
export function toPlain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export default toPlain;
