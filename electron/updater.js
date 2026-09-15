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
 * 按当前分发方式挑选要下载的资产。
 * - **安装版**（安装目录里有卸载程序）：优先 Setup exe —— 下完可直接拉起安装向导
 * - **免安装版**：优先 zip —— 装 exe 会在系统里多出一份，与当前目录的便携形态冲突
 * @param {Array<{name:string,url:string,size:number}>} assets
 * @param {boolean} installed 是否安装版
 * @returns {{name:string,url:string,size:number}|null}
 */
function pickAssetFor(assets, installed) {
  const list = assets || [];
  const setup = list.find((a) => /setup/i.test(a.name) && /\.exe$/i.test(a.name)) || list.find((a) => /\.exe$/i.test(a.name));
  const zip = list.find((a) => /\.zip$/i.test(a.name));
  return (installed ? setup || zip : zip || setup) || null;
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

/**
 * 决定「拉起更新包」这一步该做什么 —— 纯函数，便于自检（main.js 依赖 Electron，测不了）。
 *
 * 两种分支完全不同，**绝不能混**：
 *   · reveal=true（免安装版：下载的是 zip）→ 只在资源管理器里定位，用户自己解压。
 *     此时应用**必须继续运行**，关掉反而让人莫名其妙。
 *   · reveal=false（安装版：下载的是 Setup exe）→ 运行安装向导，然后**本应用要主动退出**：
 *     安装程序要替换 TeyvatMelody.exe 与 resources/ 下的文件，而当前进程正持有这些句柄，
 *     不退出的话 NSIS 会卡在「文件被占用」或要求用户手动关闭。
 *
 * @param {boolean} reveal 是否只定位不运行
 * @returns {{action:"reveal"|"run", quitAfter:boolean}}
 */
function installAction(reveal) {
  return reveal ? { action: "reveal", quitAfter: false } : { action: "run", quitAfter: true };
}

/**
 * 更新包被拉起后**隔多久退出**。
 *
 * 历史上这里是固定的 1500ms，结果**真的没退出**：exe 有 93MB，`shell.openPath` 返回时
 * 安装程序**进程才刚起来**，要好几秒才画完向导窗口。这期间：
 *   · 我们的 `before-quit` 会 `backendProc.kill()`；
 *   · 而 NSIS 的 `allowOnlyOneInstallerInstance` 在升级路径上会**反复 taskkill 宿主应用**。
 *
 * 两边同时动手，安装程序自己先没的几率不低 —— 用户看到的表现就是
 * 「向导弹出来了，但软件还开着，只能手动关掉它」。
 *
 * 所以判据不能是「固定睡多久」，而是**等安装程序真的稳定下来**：
 * 先等它出现（有窗口且活过起始宽限期），再往后多留一段缓冲让它把文件解出来。
 *
 * @param {{alive:boolean, elapsedMs:number, hasWindow:boolean, seenWindow:boolean}} st 一次采样
 * @returns {"wait"|"quit"|"abort"}
 *   wait  = 安装程序刚起来，继续等
 *   quit  = 它已经稳定运行（或一直没等到），现在退出本应用
 *   abort = 用户放弃了/它根本没起来，**别退**，否则用户会莫名丢失界面
 */
const SPAWN_GRACE_MS = 1500; // 从拉起算起：至少活过这么久才算「真的起来了」
const SETTLE_MS = 5000; // 有窗口之后再稳定运行这么久 → 可以退了
const SPAWN_DEADLINE_MS = 20000; // 兜底：一直等不到也退，总不能让用户干等

function installQuitDecision(st) {
  const { alive, elapsedMs, hasWindow, seenWindow } = st || {};
  if (!alive) {
    // 从未出现过窗口就死了 → 安装程序没起来，此时退出等于把用户晾在原地
    return seenWindow ? "quit" : "abort";
  }
  if (!seenWindow) return elapsedMs >= SPAWN_DEADLINE_MS ? "quit" : "wait";
  return elapsedMs >= SPAWN_GRACE_MS + SETTLE_MS ? "quit" : "wait";
}

module.exports = {
  checkForUpdate,
  isNewer,
  pickAssets,
  pickAssetFor,
  installAction,
  installQuitDecision,
  SPAWN_GRACE_MS,
  SETTLE_MS,
  SPAWN_DEADLINE_MS,
  REPO,
  API_URL,
};
