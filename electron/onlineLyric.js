// onlineLyric：在线歌曲歌词获取与解析。
//
// 洛雪契约里 `lyric` / `pic` 只有 `local` 源会声明，第三方聚合源普遍只声明 `musicUrl`
//（实测 v6 源五个平台全部只有 musicUrl），因此**平台歌词接口才是主路径**，
// 源声明的 `lyric` action 作为优先尝试（兼容扩展了该能力的源）。
//
// 统一输出（直接交给前端，前端零解析）：
//   [{ t: 秒, text: "主歌词 | 翻译", words?: [{ t: 秒, d: 秒, text: "字" }] }]
// - 翻译以 ` | ` 内联合并进 text —— 复用项目既有的主/副歌词分隔符约定
//   （见 LyricsPanel.vue 的 SEPARATORS 与 electron/lyrics.html 的 splitMainSub），
//   这样 showTranslation 开关在主界面、全屏、桌面歌词三处自动生效。
// - words 为逐字时间轴：有则桌面歌词走**真逐字**，无则回退按行插值。
const zlib = require("zlib");
const { request } = require("./onlineSearch");

const TIMEOUT = 12000;

// ---------------- 基础解析 ----------------

const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

/** HTML 实体还原（QQ 歌词里会有 &#58; 之类的转义） */
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const _LRC_TIME = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** 标准 LRC → [{ t, text }]（多时间戳行展开，同时间行合并） */
function parseLrc(text) {
  if (!text) return [];
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    _LRC_TIME.lastIndex = 0;
    const stamps = [...raw.matchAll(_LRC_TIME)];
    if (!stamps.length) continue;
    const body = raw.slice(stamps[stamps.length - 1].index + stamps[stamps.length - 1][0].length).trim();
    if (!body) continue;
    for (const m of stamps) {
      const frac = (m[3] || "0").padEnd(3, "0").slice(0, 3);
      rows.push({ t: round3(Number(m[1]) * 60 + Number(m[2]) + Number(frac) / 1000), text: body });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  const merged = [];
  for (const row of rows) {
    if (merged.length && merged[merged.length - 1].t === row.t) merged[merged.length - 1].text += " " + row.text;
    else merged.push(row);
  }
  return merged;
}

// 逐字片段：<offsetMs,durationMs[,extra]>字…（LX 用两段，酷狗 KRC 用三段）
const _WORD = /<(\d+),(\d+)(?:,\d+)?>([^<]*)/g;

/** 从一行的剩余部分抽出逐字时间轴；无 <…> 时返回空 words */
function parseWords(rest, lineStart) {
  const words = [];
  let text = "";
  _WORD.lastIndex = 0;
  let m;
  while ((m = _WORD.exec(rest))) {
    const chunk = m[3];
    if (!chunk) continue;
    words.push({ t: round3(lineStart + Number(m[1]) / 1000), d: round3(Number(m[2]) / 1000), text: chunk });
    text += chunk;
  }
  return { words, text };
}

/**
 * LX 逐字歌词：`[mm:ss.ms]<offset,duration>字<offset,duration>字…`
 * 洛雪契约中 `lxlyric` 字段的格式。
 */
function parseLxLyric(text) {
  if (!text) return [];
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/);
    if (!m) continue;
    const frac = (m[3] || "0").padEnd(3, "0").slice(0, 3);
    const start = Number(m[1]) * 60 + Number(m[2]) + Number(frac) / 1000;
    const rest = raw.slice(m[0].length);
    const { words, text: joined } = parseWords(rest, start);
    // 无 <…> 逐字片段时退回该行纯文本：lxlyric 允许混有普通行，不能整行丢弃
    const body = words.length ? joined : rest.trim();
    if (!body) continue;
    rows.push(words.length ? { t: round3(start), text: body, words } : { t: round3(start), text: body });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/**
 * 酷狗 KRC（已解密）：`[行起始ms,行时长ms]<字偏移ms,字时长ms,0>字…`
 * 头部 `[ti:…]` 等元信息行不会匹配，自动跳过。
 */
function parseKrc(text) {
  if (!text) return [];
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\[(\d+),(\d+)\]/);
    if (!m) continue;
    const start = Number(m[1]) / 1000;
    const rest = raw.slice(m[0].length);
    const { words, text: joined } = parseWords(rest, start);
    // 同 parseLxLyric：无逐字片段的行退回纯文本
    const body = words.length ? joined : rest.trim();
    if (!body) continue;
    rows.push(words.length ? { t: round3(start), text: body, words } : { t: round3(start), text: body });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/**
 * 酷狗 KRC 解密：base64 → 去掉 `krc1` 头 → 与固定 16 字节密钥异或 → zlib 解压。
 * 该格式与密钥是酷狗客户端的公开实现，非本项目私有约定。
 */
const _KRC_KEY = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];

function decodeKrc(content) {
  let buf = Buffer.from(String(content || ""), "base64");
  if (buf.slice(0, 4).toString("latin1") === "krc1") buf = buf.subarray(4);
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ _KRC_KEY[i % 16];
  return zlib.inflateSync(out).toString("utf8");
}

/** 把翻译按时间戳并进主歌词（容差 0.35s；每条翻译只用一次） */
function mergeTranslation(lines, tlyricText) {
  const trans = parseLrc(tlyricText);
  if (!trans.length) return lines;
  const used = new Set();
  return lines.map((line) => {
    let hit = -1;
    let best = 0.35;
    for (let i = 0; i < trans.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(trans[i].t - line.t);
      if (d <= best) {
        best = d;
        hit = i;
      }
    }
    if (hit < 0) return line;
    used.add(hit);
    return { ...line, text: `${line.text} | ${trans[hit].text}` };
  });
}

/** 把源 / 平台返回的原始歌词组装为最终 lines（逐字优先，翻译内联合并） */
function buildLines({ lyric, tlyric, lxlyric } = {}) {
  let lines = parseLxLyric(lxlyric);
  if (!lines.length) lines = parseLrc(lyric);
  if (!lines.length) return [];
  return mergeTranslation(lines, tlyric);
}

// ---------------- 平台适配器 ----------------

async function getJson(url, headers) {
  const res = await request(url, { headers, timeout: TIMEOUT });
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`响应非 JSON（HTTP ${res.status}）`);
  }
}

/** QQ 音乐：songmid → { lyric, tlyric }（trans 为翻译，多为空） */
async function fetchTx(info) {
  const mid = info.songmid || info.mid;
  if (!mid) throw new Error("缺少 songmid");
  const qs = new URLSearchParams({ songmid: mid, format: "json", nobase64: "1", g_tk: "5381" });
  const data = await getJson(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${qs}`, {
    Referer: "https://y.qq.com/portal/player.html",
  });
  return { lyric: decodeEntities(data?.lyric), tlyric: decodeEntities(data?.trans) };
}

/** 酷狗：hash → 先查候选，再下载。优先 KRC（真逐字），失败退回 LRC。 */
async function fetchKg(info) {
  const hash = info.hash || info.FileHash;
  if (!hash) throw new Error("缺少 hash");
  const found = await getJson(
    `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=${encodeURIComponent(hash)}`
  );
  const cand = (found?.candidates || [])[0];
  if (!cand?.id) throw new Error("未找到歌词候选");

  const download = async (fmt) => {
    const qs = new URLSearchParams({
      ver: "1",
      client: "pc",
      id: String(cand.id),
      accesskey: cand.accesskey || "",
      fmt,
      charset: "utf8",
    });
    const data = await getJson(`https://lyrics.kugou.com/download?${qs}`);
    return data?.content ? String(data.content) : "";
  };

  // KRC：含逐字时间轴
  try {
    const content = await download("krc");
    if (content) {
      const krc = decodeKrc(content);
      const lines = parseKrc(krc);
      if (lines.length) return { lxlyric: toLxLyric(lines) };
    }
  } catch {
    /* KRC 不可用（部分歌曲只有 LRC）→ 落到下面 */
  }

  const content = await download("lrc");
  if (!content) throw new Error("歌词下载失败");
  return { lyric: Buffer.from(content, "base64").toString("utf8") };
}

/** 把已解析的逐字行转回 LX 逐字文本，让下游只认一种格式 */
function toLxLyric(lines) {
  return lines
    .map((line) => {
      const head = `[${String(Math.floor(line.t / 60)).padStart(2, "0")}:${(line.t % 60).toFixed(3).padStart(6, "0")}]`;
      if (!line.words?.length) return head + line.text;
      return head + line.words.map((w) => `<${Math.round((w.t - line.t) * 1000)},${Math.round(w.d * 1000)}>${w.text}`).join("");
    })
    .join("\n");
}

/** 网易云：id → { lyric, tlyric } */
async function fetchWy(info) {
  const id = info.id ?? info.songId;
  if (id == null) throw new Error("缺少歌曲 id");
  const qs = new URLSearchParams({ id: String(id), lv: "-1", tv: "-1", rv: "-1", kv: "-1" });
  const data = await getJson(`https://music.163.com/api/song/lyric?${qs}`, { Referer: "https://music.163.com/" });
  return { lyric: data?.lrc?.lyric, tlyric: data?.tlyric?.lyric };
}

/** 酷我：rid → lrclist 合成 LRC。注意 Referer 必须是 m.kuwo.cn（用 www 会被拒） */
async function fetchKw(info) {
  const rid = info.rid || info.DC_TARGETID;
  if (!rid) throw new Error("缺少 rid");
  const qs = new URLSearchParams({ musicId: String(rid).replace(/^MUSIC_/, "") });
  const data = await getJson(`https://m.kuwo.cn/newh5/singles/songinfoandlrc?${qs}`, {
    Referer: "https://m.kuwo.cn/",
  });
  const list = data?.data?.lrclist;
  if (!Array.isArray(list) || !list.length) throw new Error("未找到歌词");
  const lyric = list
    .map((row) => {
      const sec = Number(row.time);
      if (!Number.isFinite(sec)) return "";
      const mm = String(Math.floor(sec / 60)).padStart(2, "0");
      const ss = (sec % 60).toFixed(2).padStart(5, "0");
      return `[${mm}:${ss}]${String(row.lineLyric ?? "").trim()}`;
    })
    .filter(Boolean)
    .join("\n");
  return { lyric };
}

const FETCHERS = { tx: fetchTx, kg: fetchKg, wy: fetchWy, kw: fetchKw };

// ---------------- 对外接口 ----------------

/**
 * 取在线歌曲歌词。
 * @param {string} source 平台 key（tx/kg/wy/kw）
 * @param {object} musicInfo 平台歌曲信息
 * @param {{callEnabled?: Function}} [manager] 源管理器；若源声明了 lyric action 则优先使用
 * @returns {Promise<{lines: object[], origin: string}>}
 */
async function fetchLyric(source, musicInfo, manager) {
  const info = musicInfo || {};

  // 1) 优先：源自己声明了该平台的 lyric 能力（洛雪契约里仅 local 源，第三方源可能扩展）
  if (manager && typeof manager.callEnabled === "function") {
    try {
      const { result } = await manager.callEnabled(source, "lyric", { musicInfo: info });
      const lines = buildLines(result || {});
      if (lines.length) return { lines, origin: "source" };
    } catch {
      /* 源不支持 lyric → 落平台接口 */
    }
  }

  // 2) 平台歌词接口
  const fetcher = FETCHERS[source];
  if (!fetcher) throw new Error(`暂不支持 ${source} 的歌词`);
  const raw = await fetcher(info);
  const lines = buildLines(raw);
  if (!lines.length) throw new Error("该歌曲暂无歌词");
  return { lines, origin: "platform" };
}

module.exports = {
  fetchLyric,
  // 以下导出供离线自检使用
  parseLrc,
  parseLxLyric,
  parseKrc,
  decodeKrc,
  mergeTranslation,
  buildLines,
  toLxLyric,
  decodeEntities,
  parseWords,
  KRC_KEY: _KRC_KEY,
};
