// onlineSearch：在线歌曲搜索适配器。
//
// 洛雪自定义源脚本**不提供搜索能力**（源只负责"已知 musicInfo → 取 URL/歌词/封面"），
// 所以搜索由本模块自建：直接调用各平台公开搜索接口，把结果归一化为统一结构，
// 再交给源脚本按平台 ID 解析播放地址（见 sourceManager.resolveMusicUrl）。
//
// 归一化结构（与 docs/online-playback-lx-source-plan.md §3.3 一致）：
//   { id: 'online:{平台}:{平台ID}', online: true, source, name, singer, album,
//     duration, interval, title, artist, meta: { 全量平台 ID } }
// 其中 title/artist 是本地歌曲的字段命名，供通知、迷你窗、控制条复用同一套渲染。
const http = require("http");
const https = require("https");
const vm = require("vm");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT = 12000;

// 支持的搜索平台（kw 走老接口的伪 JSON，作兜底）
const DEFAULT_SOURCES = ["tx", "kg", "wy", "kw"];

// ---------------- HTTP ----------------

/** 轻量 HTTP 请求：返回 { status, headers, text }；跟随重定向，超时中断。 */
function request(url, { method = "GET", headers = {}, body = null, timeout = TIMEOUT, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`非法 URL：${url}`));
    }
    const lib = u.protocol === "https:" ? https : http;
    const payload = body == null ? null : Buffer.from(String(body));
    const reqHeaders = { "User-Agent": UA, Accept: "*/*", ...headers };
    if (payload) reqHeaders["Content-Length"] = payload.length;

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: reqHeaders,
        timeout,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch {
            return reject(new Error("重定向地址非法"));
          }
          return resolve(request(next, { method, headers, body, timeout, redirects: redirects - 1 }));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 请求并解析 JSON。QQ 的 JSON 接口 Content-Type 常为 application/x-javascript，故不看类型直接 parse。 */
async function getJson(url, opts) {
  const res = await request(url, opts);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`响应非 JSON（HTTP ${res.status}）`);
  }
}

/**
 * 解析「伪 JSON」（酷我老接口用单引号而非双引号，不是合法 JSON）。
 * 两级策略：先把单引号换成双引号后 JSON.parse（转义单引号 `\'` 先占位，避免被误换后语义漂移）；
 * 失败再退到**空沙箱**求值 —— 沙箱内没有任何宿主全局（无 require/process），并带 1s 超时，
 * 与洛雪生态的常规做法一致，且比直接 eval 宿主作用域安全。
 */
function parseLooseJson(text) {
  const cleaned = String(text).replace(/&nbsp;/g, " ").trim();
  const SENTINEL = "\u0000";
  const swapped = cleaned
    .split("\\'")
    .join(SENTINEL)
    .split("'")
    .join('"')
    .split(SENTINEL)
    .join("'");
  try {
    return JSON.parse(swapped);
  } catch {
    return vm.runInNewContext(`(${cleaned})`, {}, { timeout: 1000 });
  }
}

// ---------------- 归一化 ----------------

/** 归一化为统一歌曲结构；title/artist 与本地歌曲字段对齐，便于复用现有渲染与通知。 */
function normalize(source, { pid, name, singer, album, duration, picUrl, meta }) {
  const title = String(name || "").trim() || "未知歌曲";
  const artist = String(singer || "").trim();
  const secs = Math.max(0, Math.round(Number(duration) || 0));
  return {
    id: `online:${source}:${pid}`,
    online: true,
    source,
    name: title,
    singer: artist,
    album: String(album || "").trim(),
    duration: secs,
    interval: secs,
    // 远程封面：前端经同源图片代理加载（CSP img-src 'self'，不放宽策略）
    picUrl: String(picUrl || "").trim(),
    title,
    artist,
    meta,
  };
}

// ---------------- 平台响应解析（纯函数：只吃响应、吐归一化结果，便于离线自检） ----------------

/** QQ 音乐（tx）搜索响应 */
function parseTx(data) {
  const list = data?.data?.song?.list || [];
  return list
    .map((it) => {
      const songmid = it.songmid || it.mid;
      return normalize("tx", {
        pid: songmid,
        name: it.songname || it.name || it.title,
        singer: (it.singer || []).map((s) => s.name).filter(Boolean).join(" / "),
        album: it.albumname || it.album?.name,
        duration: it.interval,
        // QQ 专辑封面可由 albummid 直接构造（实测该模式有效）
        picUrl: it.albummid ? `https://y.qq.com/music/photo_new/T002R300x300M000${it.albummid}.jpg` : "",
        meta: {
          songmid,
          mid: songmid,
          songid: it.songid,
          albummid: it.albummid,
          albumId: it.albumid,
        },
      });
    })
    .filter((s) => s.meta.songmid);
}

/** 酷狗（kg）搜索响应 */
function parseKg(data) {
  const list = data?.data?.lists || [];
  return list
    .map((it) =>
      normalize("kg", {
        pid: it.FileHash,
        name: it.SongName,
        singer: it.SingerName,
        album: it.AlbumName,
        duration: it.Duration,
        // 酷狗返回带 {size} 占位符的模板，替换为实际尺寸（实测该模式有效）
        picUrl: String(it.Image || "").replace("{size}", "240"),
        meta: {
          hash: it.FileHash,
          FileHash: it.FileHash,
          albumId: it.AlbumID,
          audioId: it.AudioID,
          emixsongid: it.EMixSongID,
          mixsongid: it.MixSongID,
        },
      })
    )
    .filter((s) => s.meta.hash);
}

/** 网易云（wy）搜索响应 */
function parseWy(data) {
  const list = data?.result?.songs || [];
  return list
    .map((it) =>
      normalize("wy", {
        pid: it.id,
        name: it.name,
        singer: (it.ar || it.artists || []).map((a) => a.name).filter(Boolean).join(" / "),
        album: it.al?.name ?? it.album?.name,
        // 网易的 dt / duration 均为毫秒
        duration: Math.round((it.dt || it.duration || 0) / 1000),
        // 网易返回的是 http 链接，升级为 https 避免混合内容
        picUrl: String(it.al?.picUrl || it.album?.picUrl || "").replace(/^http:/, "https:"),
        meta: {
          id: it.id,
          songId: it.id,
          albumId: it.al?.id ?? it.album?.id,
          fee: it.fee,
        },
      })
    )
    .filter((s) => s.meta.id != null);
}

/** 酷我（kw）老接口响应（已由 parseLooseJson 解析为对象） */
function parseKw(data) {
  const list = data?.abslist || [];
  return list
    .map((it) => {
      const rid = String(it.MUSICRID || it.DC_TARGETID || "").replace(/^MUSIC_/, "");
      return normalize("kw", {
        pid: rid,
        name: it.SONGNAME,
        singer: it.ARTIST,
        album: it.ALBUM,
        duration: it.DURATION,
        // 酷我封面字段常为空，有则用（无则由前端回退占位图）
        picUrl: it.web_albumpic_short ? `https://img1.kuwo.cn/star/albumcover/${it.web_albumpic_short}` : "",
        meta: { rid, MUSICRID: it.MUSICRID, DC_TARGETID: it.DC_TARGETID, albumId: it.ALBUMID },
      });
    })
    .filter((s) => s.meta.rid);
}

// ---------------- 平台适配器（取数 + 解析） ----------------

async function searchTx(keyword, limit) {
  const qs = new URLSearchParams({
    w: keyword,
    p: "1",
    n: String(limit),
    format: "json",
    aggr: "1",
    cr: "1",
    t: "0",
  });
  return parseTx(await getJson(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${qs}`));
}

async function searchKg(keyword, limit) {
  const qs = new URLSearchParams({
    keyword,
    page: "1",
    pagesize: String(limit),
    platform: "WebFilter",
    userid: "-1",
    clientver: "2000",
    iscorrection: "1",
    privilege_filter: "0",
    filter: "10",
    appid: "1014",
  });
  return parseKg(await getJson(`https://songsearch.kugou.com/song_search_v2?${qs}`));
}

async function searchWy(keyword, limit) {
  const body = new URLSearchParams({ s: keyword, type: "1", limit: String(limit), offset: "0" }).toString();
  const data = await getJson("https://music.163.com/api/cloudsearch/pc", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://music.163.com/" },
    body,
  });
  return parseWy(data);
}

async function searchKw(keyword, limit) {
  const qs = new URLSearchParams({
    all: keyword,
    ft: "music",
    itemset: "web_2013",
    client: "kt",
    pn: "0",
    rn: String(limit),
    rformat: "json",
    encoding: "utf8",
  });
  const res = await request(`http://search.kuwo.cn/r.s?${qs}`, { headers: { Referer: "http://www.kuwo.cn/" } });
  return parseKw(parseLooseJson(res.text));
}

const SEARCHERS = { tx: searchTx, kg: searchKg, wy: searchWy, kw: searchKw };

// ---------------- 对外接口 ----------------

/**
 * 并发搜索多个平台；**单个平台失败不影响其它平台**（错误收集在 errors 里）。
 * @param {string} keyword 关键词
 * @param {string[]} [sources] 要查询的平台，缺省为四平台全查
 * @param {number} [limit] 每平台返回条数
 * @returns {Promise<{list: object[], errors: string[]}>}
 */
async function search(keyword, sources, limit = 30) {
  const kw = String(keyword || "").trim();
  if (!kw) return { list: [], errors: [] };
  const picked = (Array.isArray(sources) && sources.length ? sources : DEFAULT_SOURCES).filter((s) => SEARCHERS[s]);
  if (!picked.length) return { list: [], errors: ["没有可用的搜索平台"] };

  const results = await Promise.all(
    picked.map(async (source) => {
      try {
        return { list: await SEARCHERS[source](kw, limit), error: null };
      } catch (e) {
        return { list: [], error: `${source}: ${e.message}` };
      }
    })
  );
  return {
    list: results.flatMap((r) => r.list),
    errors: results.filter((r) => r.error).map((r) => r.error),
  };
}

module.exports = {
  search,
  DEFAULT_SOURCES,
  // 以下导出供离线自检使用
  normalize,
  parseLooseJson,
  request,
  parseTx,
  parseKg,
  parseWy,
  parseKw,
};
