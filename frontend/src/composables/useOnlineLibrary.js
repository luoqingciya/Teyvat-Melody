// useOnlineLibrary：在线歌曲的「入库 / 收藏 / 加歌单 / 换音质 / 下载」统一入口。
//
// 设计要点：
//   · 在线歌曲在后端 songs 表里占一行即可复用既有收藏与歌单机制，所以任何需要
//     「id」的操作前都先 ensureRegistered() 拿到整数 id。
//   · 下载走两步：先让主进程按选定音质解析出真实地址（含降级与换源），
//     再把地址交给后端取流落盘 —— 后端只做「取流 + 登记」，不碰源脚本。
//   · 平台音质声明（源脚本 inited 上报）缓存在模块级，多处 UI 共用一份。
import { computed, ref } from "vue";
import { useApi } from "@/composables/useApi";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { toast, toastError } from "@/utils/toast";
import {
  DEFAULT_QUALITY_CHAIN,
  buildMusicInfo,
  decorateSong,
  isOnlineRow,
  isOnlineSong,
  linesToLrc,
  onlineCacheKey,
  onlineKeyOf,
  platformIdOf,
} from "@/utils/onlineSong";

// ---- 模块级共享状态（多个组件共用，避免重复拉取） ----
const qualitys = ref({}); // { kw: ["128k","320k","flac","flac24bit"], ... }
const downloadedKeys = ref(new Set()); // "kw:MUSIC_123" 已下载入库
const downloads = ref({}); // key → { percent, received, total, done, error, name }
let metaLoaded = false;

/** 该平台源声明支持的音质（未声明时退回默认降级链，与主进程一致） */
function qualitiesFor(source) {
  const list = qualitys.value[source];
  return Array.isArray(list) && list.length ? list : DEFAULT_QUALITY_CHAIN;
}

export function useOnlineLibrary() {
  const api = useApi();
  const library = useLibraryStore();
  const player = usePlayerStore();

  /** 拉取各平台的音质声明（源脚本上报），多处 UI 共用；已加载过则不重复请求 */
  async function loadMeta(force = false) {
    if (metaLoaded && !force) return;
    const bridge = window.pywebview?.api;
    if (!bridge || typeof bridge.getOnlinePlatforms !== "function") return;
    try {
      const r = await bridge.getOnlinePlatforms();
      qualitys.value = r?.qualitys ?? {};
      metaLoaded = true;
    } catch {
      /* 拿不到就按默认降级链展示，不打扰用户 */
    }
  }

  /** 拉取「已下载」键集合（搜索页据此标注，避免重复下载） */
  async function loadDownloaded() {
    try {
      const keys = await api.loadDownloadedKeys();
      downloadedKeys.value = new Set(Array.isArray(keys) ? keys : []);
    } catch {
      /* 忽略 */
    }
  }

  function isDownloaded(song) {
    const key = onlineKeyOf(song);
    return !!key && downloadedKeys.value.has(key);
  }

  /** 该曲是否正在下载（按钮据此置灰，避免连点出两份重复文件） */
  function isDownloading(song) {
    const key = onlineKeyOf(song);
    const cur = key ? downloads.value[key] : null;
    return !!cur && !cur.done;
  }

  /**
   * 确保该在线歌曲已在曲库中（返回带整数 id 的歌曲对象）。
   * 搜索结果只有字符串 id，收藏 / 加歌单 / 播放统计都需要整数 id，故先登记。
   *
   * 已经有整数 id 就直接返回（幂等）：后端按「在线身份」查重，同一首歌永远命中同一行，
   * 所以重复调用不会堆出多行；但能省掉一次往返。
   */
  async function ensureRegistered(song) {
    if (!isOnlineSong(song)) return song;
    if (typeof song.id === "number") return song;
    const row = await api.registerOnlineSong({
      source: song.source,
      platformId: platformIdOf(song),
      title: song.title ?? song.name ?? "",
      artist: song.artist ?? song.singer ?? "",
      album: song.album ?? "",
      duration: song.duration ?? song.interval ?? 0,
      coverUrl: song.picUrl ?? song.cover ?? "",
      quality: song.quality ?? "",
      meta: song.meta ?? {},
    });
    if (!row) throw new Error("在线歌曲入库失败");
    const fresh = decorateSong(row);
    // 就地升级原对象：搜索结果对象被队列/当前播放引用着，换新对象会脱钩
    Object.assign(song, fresh, { quality: song.quality || fresh.quality || "" });
    await library.loadOnlineSongs();
    return song;
  }

  /** 收藏 / 取消收藏（在线歌曲自动先入库） */
  async function toggleFavorite(song) {
    try {
      await ensureRegistered(song);
      const fav = await library.toggleFavorite(song);
      toast(fav ? "已收藏" : "已取消收藏");
      return fav;
    } catch (e) {
      toastError(`收藏失败：${e.message}`);
      return false;
    }
  }

  /** 加入歌单（在线歌曲自动先入库） */
  async function addToPlaylist(song, playlistId) {
    await ensureRegistered(song);
    return api.addPlaylistSong(playlistId, song.id);
  }

  /**
   * 设定首选音质：记住偏好；若正是当前播放的在线歌曲，则立即换源并从当前位置续播。
   */
  async function setQuality(song, quality) {
    const q = quality || "";
    song.quality = q;
    if (typeof song.id === "number" && song.online_source) {
      try {
        await api.setOnlineQuality(song.id, q);
      } catch {
        /* 记不住偏好不影响本次播放 */
      }
    }
    if (player.currentSong && player.currentSong.id === song.id) {
      await player.switchOnlineQuality(q);
    }
  }

  /**
   * 下载到本地曲库（可指定音质）。
   *
   * 顺序很重要：先解析地址（主进程，含降级与换源），再顺带取歌词，
   * 最后交给后端取流落盘并登记 —— 这样下载回来的歌与扫描入库的歌完全等价。
   */
  async function download(song, quality) {
    const bridge = window.pywebview?.api;
    if (!bridge || typeof bridge.getOnlineUrl !== "function") {
      toastError("当前环境不支持下载（缺少主进程桥接）");
      return null;
    }
    const key = onlineKeyOf(song);
    // 重入保护：连点两次会并发落出两份重复文件（后端也有同键闸，这里先拦一道）
    if (isDownloading(song)) return null;
    downloads.value = { ...downloads.value, [key]: { percent: 0, received: 0, total: 0, done: false } };
    try {
      const r = await bridge.getOnlineUrl(song.source, buildMusicInfo(song), quality || song.quality || "");
      if (!r || !r.ok || !r.url) throw new Error(r?.message || "未获取到下载地址");

      // 歌词顺带取回写成同名 .lrc，让下载回来的歌离线也有歌词
      let lyrics = "";
      if (typeof bridge.getOnlineLyric === "function") {
        try {
          const lr = await bridge.getOnlineLyric(song.source, buildMusicInfo(song));
          lyrics = linesToLrc(lr?.lines);
        } catch {
          /* 没歌词不影响下载 */
        }
      }

      const cacheKey = onlineCacheKey(song, r.quality);
      const polling = pollProgress(key, cacheKey);
      const res = await api.downloadOnlineSong({
        url: r.url,
        source: song.source,
        key: cacheKey,
        quality: r.quality || "",
        platformId: platformIdOf(song),
        songId: typeof song.id === "number" ? song.id : undefined,
        meta: {
          title: song.title ?? song.name ?? "",
          artist: song.artist ?? song.singer ?? "",
          album: song.album ?? "",
          duration: song.duration ?? song.interval ?? 0,
          coverUrl: song.picUrl ?? song.cover ?? "",
        },
        lyrics,
      });
      clearInterval(polling);
      if (!res || res.code !== 200 || !res.data) throw new Error(res?.message || "下载失败");

      const local = res.data;
      downloads.value = { ...downloads.value, [key]: { percent: 100, done: true, song: local } };
      // 下载完成后这首歌在曲库里已经是**本地行**（后端把它就地转了，不会另起一行）。
      // 让搜索结果对象也跟着切到本地：此后播放直连本地文件（离线可用、不再耗流量），
      // 但**保留 source / meta** —— 来源徽标与「已下载」标记仍要显示。
      if (local && typeof local.id === "number" && !isOnlineRow(local)) {
        song.id = local.id;
        song.online = false;
      }
      await Promise.all([library.load(), loadDownloaded()]);
      // 本地歌曲不走在线链路，直接刷新音乐库即可
      toast(`已下载《${local.title}》到本地音乐库`);
      return local;
    } catch (e) {
      downloads.value = { ...downloads.value, [key]: { percent: 0, done: true, error: e.message } };
      toastError(`下载失败：${e.message}`);
      return null;
    }
  }

  /** 轮询下载进度（无损一首 50MB，没有进度反馈用户会以为卡死） */
  function pollProgress(songKey, cacheKey) {
    return setInterval(async () => {
      try {
        const p = await api.getDownloadProgress(cacheKey);
        if (!p) return;
        const cur = downloads.value[songKey] || {};
        downloads.value = { ...downloads.value, [songKey]: { ...cur, ...p } };
      } catch {
        /* 轮询失败无所谓，最终以请求返回为准 */
      }
    }, 500);
  }

  function progressOf(song) {
    const key = onlineKeyOf(song);
    return key ? downloads.value[key] || null : null;
  }

  return {
    qualitys: computed(() => qualitys.value),
    downloadedKeys: computed(() => downloadedKeys.value),
    downloads,
    loadMeta,
    loadDownloaded,
    qualitiesFor,
    isDownloaded,
    isDownloading,
    ensureRegistered,
    toggleFavorite,
    addToPlaylist,
    setQuality,
    download,
    progressOf,
  };
}
