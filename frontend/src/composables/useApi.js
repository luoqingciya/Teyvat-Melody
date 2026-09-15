// useApi：封装后端 REST 接口。渲染进程由 Flask 同源托管，直接 fetch 请求即可。
import { platformIdOf } from "@/utils/onlineSong";

function jget(url) {
  return fetch(url).then((r) => (r.status === 404 ? Promise.resolve(null) : r.json()));
}

function jpost(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());
}

function jput(url, body) {
  return fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());
}

function jdel(url) {
  return fetch(url, { method: "DELETE" }).then((r) => r.json());
}

export function useApi() {
  // 音乐库
  function startScan(path) {
    return jpost("/api/scan/start", { path }).then((res) => res.data);
  }
  function getScanStatus(scanId) {
    return jget(`/api/scan/status/${scanId}`).then((res) => res?.data ?? null);
  }
  function selectFolder() {
    // 通过后端原生文件对话框选择目录（浏览器 / pywebview 环境通用）
    return fetch("/api/pick-folder")
      .then((r) => r.json())
      .then((res) => res.data ?? null);
  }
  function loadSongs() {
    return jget("/api/songs");
  }
  function loadFavorites() {
    return jget("/api/favorites");
  }
  function toggleFavorite(songId) {
    return jpost(`/api/favorites/${songId}`);
  }
  function getLyrics(songId) {
    return jget(`/api/lyrics/${songId}`);
  }
  function updateSong(songId, fields) {
    return jput(`/api/songs/${songId}`, fields);
  }
  function updateLyrics(songId, text) {
    return jput(`/api/lyrics/${songId}`, { text });
  }
  function getDuplicates() {
    return jget("/api/duplicates");
  }
  function recordPlay(songId) {
    return jpost(`/api/songs/${songId}/play`);
  }
  /**
   * 上报一次播放，**支持尚未入库的在线歌曲**。
   *
   * 在线歌曲的 id 是平台字符串，后端没法直接记 —— 需要完整身份才能「先入库、再记录」。
   * 返回入库后的歌曲行（在线歌曲据此拿到整数 id，之后就能进最近播放、被收藏/加歌单）。
   */
  function recordPlayback(song) {
    if (!song) return Promise.resolve(null);
    const id = typeof song === "object" ? song.id : song;
    const unwrap = (r) => r?.data ?? null;
    if (typeof id === "number") {
      return jpost("/api/playback/record", { songId: id }).then(unwrap);
    }
    if (typeof song !== "object") return Promise.resolve(null);
    return jpost("/api/playback/record", {
      source: song.source || song.online_source || "",
      platformId: platformIdOf(song),
      title: song.title ?? song.name ?? "",
      artist: song.artist ?? song.singer ?? "",
      album: song.album ?? "",
      duration: song.duration ?? song.interval ?? 0,
      coverUrl: song.picUrl ?? song.cover ?? "",
      quality: song.quality ?? "",
      meta: song.meta ?? {},
    }).then(unwrap);
  }
  function getPlaybackStats(days = 30) {
    return jget(`/api/playback/stats?days=${days}`);
  }

  // 在线播放缓存（设置页）
  function getOnlineCache() {
    return jget("/api/online/cache").then((res) => res?.data ?? null);
  }
  function clearOnlineCache() {
    return jpost("/api/online/cache/clear").then((res) => res?.data ?? null);
  }
  function setOnlineCacheConfig(patch) {
    return jpost("/api/online/cache/config", patch).then((res) => res?.data ?? null);
  }

  // 在线歌曲入库（收藏 / 歌单 / 下载）
  function registerOnlineSong(payload) {
    return jpost("/api/online/register", payload).then((res) => res?.data ?? null);
  }
  function loadOnlineLibrary() {
    return jget("/api/online/library");
  }
  function loadDownloadedKeys() {
    return jget("/api/online/downloaded").then((res) => res?.data ?? []);
  }
  function setOnlineQuality(songId, quality) {
    return jput(`/api/online/songs/${songId}/quality`, { quality }).then((res) => res?.data ?? null);
  }
  function removeOnlineSong(songId) {
    return jdel(`/api/online/songs/${songId}`).then((res) => res?.data ?? null);
  }
  /** 下载：url 由主进程按选定音质解析好后传入，后端只负责取流落盘并登记 */
  function downloadOnlineSong(payload) {
    return jpost("/api/online/download", payload);
  }
  function getDownloadProgress(key) {
    return jget(`/api/online/download/progress?key=${encodeURIComponent(key)}`).then((res) => res?.data ?? null);
  }

  // 歌单
  function loadPlaylists() {
    return jget("/api/playlists");
  }
  function createPlaylist(name) {
    return jpost("/api/playlists", { name });
  }
  function deletePlaylist(id) {
    return jdel(`/api/playlists/${id}`);
  }
  function getPlaylistSongs(id) {
    return jget(`/api/playlists/${id}/songs`);
  }
  function addPlaylistSong(id, songId) {
    return jpost(`/api/playlists/${id}/songs`, { song_id: songId });
  }
  function exportPlaylist(id) {
    return jget(`/api/playlists/${id}/export`);
  }
  function importPlaylist(id, m3u) {
    return jpost(`/api/playlists/${id}/import`, { m3u });
  }

  return {
    startScan,
    getScanStatus,
    selectFolder,
    loadSongs,
    loadFavorites,
    toggleFavorite,
    getLyrics,
    updateSong,
    updateLyrics,
    getDuplicates,
    recordPlay,
    recordPlayback,
    getPlaybackStats,
    getOnlineCache,
    clearOnlineCache,
    setOnlineCacheConfig,
    registerOnlineSong,
    loadOnlineLibrary,
    loadDownloadedKeys,
    setOnlineQuality,
    removeOnlineSong,
    downloadOnlineSong,
    getDownloadProgress,
    loadPlaylists,
    createPlaylist,
    deletePlaylist,
    getPlaylistSongs,
    addPlaylistSong,
    exportPlaylist,
    importPlaylist,
  };
}
