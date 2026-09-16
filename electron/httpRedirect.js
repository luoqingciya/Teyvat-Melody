// httpRedirect：重定向判定（纯函数，便于单测）。
//
// 为什么单独抽出来：这个项目零运行时依赖，所有对外请求都是手写的 http/https 调用，
// 而**手写请求最容易漏掉的就是跟随重定向**。实测踩到的坑：
// GitHub 的 Release 资产下载地址会
//   https://github.com/…/releases/download/v1.0.16/xxx.exe
//     --302--> https://release-assets.githubusercontent.com/…
//     --200--> 文件
// 不跟随就只会看到「HTTP 302」，而且**开不开代理都一样**（这是代码问题，不是网络问题）——
// 用户很容易误以为是代理没配好，白折腾半天。

/** 需要跟随的状态码（301/302/303 语义上都是「去别处」，307/308 保留方法） */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/** 最多跟几跳。防重定向环（A→B→A 会让请求永远不返回）。 */
const MAX_REDIRECTS = 5;

/**
 * 判断这次响应是不是重定向，是则算出下一跳的绝对地址。
 *
 * @param {number} status HTTP 状态码
 * @param {string} location 响应头 location
 * @param {string} baseUrl 当前请求的地址（location 可能是相对路径）
 * @returns {string|null} 下一跳的绝对 URL；不需要跟随则 null
 */
function redirectTarget(status, location, baseUrl) {
  if (!REDIRECT_CODES.has(Number(status))) return null;
  if (!location) return null; // 3xx 但没给 location：跟不了，交给调用方按错误处理
  let next;
  try {
    next = new URL(String(location), baseUrl);
  } catch {
    return null;
  }
  // 只允许 http/https：别被一个 location 骗去读本地文件
  if (next.protocol !== "http:" && next.protocol !== "https:") return null;
  return next.href;
}

module.exports = { redirectTarget, MAX_REDIRECTS, REDIRECT_CODES };
