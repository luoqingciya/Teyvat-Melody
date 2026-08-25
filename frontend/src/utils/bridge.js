// bridge：判断是否在 pywebview 环境，供 useApi 等模块复用。
export const isPyWebview = () =>
  Boolean(window.pywebview?.api);

export function callPython(fn, ...args) {
  if (!isPyWebview()) {
    throw new Error("当前不在 pywebview 环境中，无法直接调用 Python API");
  }
  return window.pywebview.api[fn](...args);
}

export default { isPyWebview, callPython };