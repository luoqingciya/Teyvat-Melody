// updater：检查 GitHub Release 是否有新版本。
//
// 为什么不用 electron-updater：它只支持 NSIS 安装版（zip 免安装版没有安装位置），
// 且未签名时自动下载的更新包会被 Windows SmartScreen 拦截。这里只做「查 + 告知 + 跳转下载」，
// 安装版与免安装版都能用，也不需要新增运行时依赖。
//
// 公开仓库查 Release 不需要 token；私有仓库才需要。
const REPO = "luoqingciya/Teyvat-Melody";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const TIMEOUT = 10000;
const NOTES_LIMIT = 6000; // 发布说明截断长度，避免把整篇 markdown 塞进界面

/**
 * 版本号比较：a 是否比 b 新。
 * 只比较数字段（本项目未使用 pre-release 后缀），位数不同时缺位按 0 处理。
 * @returns {boolean}
 */
function isNewer(a, b) {
  const parse = (v) =>
    String(v || "")
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 从 Release 响应里挑出与当前平台匹配的下载项（Windows 安装包 / 免安装包）。 */
function pickAssets(assets) {
  return (assets || [])
    .filter((a) => /\.(exe|zip)$/i.test(a.name || ""))
    .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size || 0 }));
}

/**
 * 查询最新 Release 并与当前版本比对。
 * @param {string} currentVersion 当前版本（app.getVersion()）
 * @param {{fetchImpl?: Function, apiUrl?: string}} [opts] 便于测试注入
 * @returns {Promise<object>} { ok, hasUpdate, current, latest, ... }；失败时 ok=false 且带 message
 */
async function checkForUpdate(currentVersion, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const apiUrl = opts.apiUrl || API_URL;
  try {
    const res = await doFetch(apiUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "TeyvatMelody-Updater" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
      // 404 通常是还没有发布任何 Release（不算错误，提示一下即可）
      return { ok: false, hasUpdate: false, current: currentVersion, message: `GitHub API ${res.status}` };
    }
    const rel = await res.json();
    const latest = String(rel.tag_name || "").replace(/^v/i, "");
    const base = { ok: true, current: String(currentVersion || ""), latest };
    if (!latest || !isNewer(latest, currentVersion)) return { ...base, hasUpdate: false };
    return {
      ...base,
      hasUpdate: true,
      title: rel.name || rel.tag_name || latest,
      notes: String(rel.body || "").slice(0, NOTES_LIMIT),
      pageUrl: rel.html_url || `https://github.com/${REPO}/releases`,
      publishedAt: rel.published_at || "",
      assets: pickAssets(rel.assets),
    };
  } catch (e) {
    return { ok: false, hasUpdate: false, current: currentVersion, message: e.message };
  }
}

module.exports = { checkForUpdate, isNewer, pickAssets, REPO, API_URL };
