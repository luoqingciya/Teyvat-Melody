// onlineSong：在线歌曲的统一工具模块。
//
// 在线歌曲在后端 `songs` 表里占一行（online_source 非空，无本地文件），在前端则被
// 「补全」成与搜索结果的同一形状（online / source / meta / picUrl）——这样收藏、
// 歌单、队列、最近播放、切歌通知、桌面歌词这些既有机制全都能零改动复用。
//
// 这里集中三件事：
//   1. 形状还原：后端行 ⇄ 前端在线歌曲对象（decorateSong / buildMusicInfo）
//   2. 播放寻址：稳定缓存键与同源代理地址（onlineCacheKey / proxyUrl）
//   3. 歌词导出：把解析好的歌词行写回 LRC 文本（linesToLrc，下载时落成 .lrc）
//
// 平台 ID 别名：源脚本读的字段名各平台不同（kw 读 songmid、kg 读 hash），
// 所以把同一个 id 铺满所有常见字段名，最大化兼容 —— 这是本项目的既有约定。
import { toPlain } from "@/utils/bridge";

/** 平台 ID 的所有常见字段名（源脚本取值习惯不一，全部铺满） */
export const ID_KEYS = ["songmid", "hash", "rid", "id", "mid", "FileHash"];

/** 音质降级链（源未声明音质时按此顺序尝试，取最高可用） */
export const DEFAULT_QUALITY_CHAIN = ["flac24bit", "flac", "320k", "128k"];

/** 是否为在线歌曲 ID（形如 online:{平台}:{平台ID}，搜索结果用的临时 ID） */
export function isOnlineId(id) {
  return typeof id === "string" && id.startsWith("online:");
}

/** 是否为在线歌曲对象（显式 online 标记，或字符串 ID） */
export function isOnlineSong(song) {
  return !!song && (song.online === true || isOnlineId(song.id));
}

/** 该后端行是否为在线歌曲记录（online_source 非空） */
export function isOnlineRow(song) {
  return !!song && typeof song.online_source === "string" && song.online_source !== "";
}

/**
 * 把在线歌曲展开成源脚本期望的 musicInfo：携带全量平台 ID，最大化兼容不同源脚本取值习惯。
 * 返回**普通值**（非 reactive）：跨 contextBridge 传给主进程前必须去代理，
 * 否则结构化克隆会拒绝（曾报 "An object could not be cloned."）。
 */
export function buildMusicInfo(song) {
  const info = song?.meta && typeof song.meta === "object" ? { ...song.meta } : {};
  const name = song?.name ?? song?.title;
  const singer = song?.singer ?? song?.artist;
  if (name) info.name = name;
  if (singer) info.singer = singer;
  if (song?.album) info.album = song.album;
  if (song?.interval != null && info.interval == null) info.interval = song.interval;
  const firstId = ID_KEYS.map((k) => info[k]).find((v) => v != null && v !== "");
  if (firstId != null) {
    for (const k of ID_KEYS) {
      if (info[k] == null || info[k] === "") info[k] = firstId;
    }
  }
  return toPlain(info);
}

/**
 * 在线歌曲的缓存键：平台 + 平台ID + 音质。
 * **不能拿 CDN 地址当键** —— 它带时效签名、每次播放都不一样，永远命不中缓存；
 * 而同一首歌的音频字节是稳定的，所以用这个键。
 */
export function onlineCacheKey(song, quality) {
  const id = platformIdOf(song);
  if (!id) return "";
  const source = song?.source || song?.online_source || "";
  return `${source}:${id}:${quality || ""}`;
}

/** 在线歌曲的稳定标识 `{平台}:{平台ID}`（判断「已下载 / 已收藏」用，与音质无关） */
export function onlineKeyOf(song) {
  const id = platformIdOf(song);
  const source = song?.source || song?.online_source || "";
  if (!source || !id) return "";
  return `${source}:${id}`;
}

/** 取出平台 ID（搜索结果与入库行都适用） */
export function platformIdOf(song) {
  if (!song) return "";
  const meta = song.meta && typeof song.meta === "object" ? song.meta : {};
  const id =
    song.online_id ?? meta.songmid ?? meta.hash ?? meta.rid ?? meta.id ?? meta.mid ?? meta.FileHash ?? "";
  return id === null || id === undefined ? "" : String(id);
}

/** 真实 CDN URL → 同源代理地址（Range 透传与 Referer 伪装由后端代理负责）。
 *  带上 key 后，后端会把音频缓存到本地，重播与 seek 都走本地文件。 */
export function proxyUrl(url, source, cacheKey) {
  const k = cacheKey ? `&key=${encodeURIComponent(cacheKey)}` : "";
  return `/api/online/proxy?url=${encodeURIComponent(url)}&source=${encodeURIComponent(source || "")}${k}`;
}

/** 把后端行还原成前端歌曲对象（本地行原样返回，只补一个 online:false 便于判断） */
export function decorateSong(song) {
  if (!song) return song;
  if (!isOnlineRow(song)) return { ...song, online: false };

  // 存下来的完整 musicInfo 优先（源脚本要的平台专有字段都在里面），
  // 再补上 id 别名，保证任何取法都能拿到平台 ID。
  let meta = {};
  if (typeof song.online_meta === "string" && song.online_meta) {
    try {
      const parsed = JSON.parse(song.online_meta);
      if (parsed && typeof parsed === "object") meta = parsed;
    } catch {
      /* 元信息损坏不致命：退回只用 online_id */
    }
  }
  const platformId = song.online_id ?? "";
  if (platformId !== "" && platformId != null) {
    for (const k of ID_KEYS) {
      if (meta[k] == null || meta[k] === "") meta[k] = platformId;
    }
  }
  const cover = song.cover_url || song.picUrl || "";
  return {
    ...song,
    online: true,
    source: song.online_source,
    quality: song.online_quality || "",
    picUrl: cover,
    cover,
    meta,
  };
}

/** 批量转换（列表接口用） */
export function decorateSongs(list) {
  return Array.isArray(list) ? list.map(decorateSong) : [];
}

/** 音质标识 → 展示文案（源脚本用的是 flac24bit / 320k 这类内部标识） */
export function qualityLabel(q) {
  const s = String(q || "").trim();
  if (!s) return "自动";
  // ⚠️ 文案要短：右键菜单里音质选项是等宽网格（每格约 56px），
  //    "FLAC 24bit" 会被截成 "FLAC …"，看不全还难看。列表音质列本来也只放短码。
  const map = { flac24bit: "24bit", flac: "FLAC", "320k": "320K", "128k": "128K", "192k": "192K", "256k": "256K", hires: "Hi-Res", atmos: "Atmos", master: "Master" };
  return map[s.toLowerCase()] || s.toUpperCase();
}

/**
 * 把主进程解析好的歌词行序列化回 LRC 文本（下载时写成同名 .lrc 用）。
 *
 * 只输出**行级**时间轴：逐字（words）是 LX / 酷狗私有格式，写进 .lrc 反而会让
 * 其它播放器显示出一堆 `<0,300>` 标记。翻译已内联在 text 里（`主 | 译`），
 * 与本项目既有的主/副歌词分隔符约定一致。
 */
export function linesToLrc(lines) {
  if (!Array.isArray(lines) || !lines.length) return "";
  return lines
    .map((line) => {
      const t = Number(line?.t) || 0;
      const text = String(line?.text ?? "").trim();
      if (!text) return "";
      const mm = String(Math.floor(t / 60)).padStart(2, "0");
      const ss = (t % 60).toFixed(2).padStart(5, "0");
      return `[${mm}:${ss}]${text}`;
    })
    .filter(Boolean)
    .join("\n");
}
