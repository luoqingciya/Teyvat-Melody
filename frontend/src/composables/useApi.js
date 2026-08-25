// useApi：封装后端 REST 接口。渲染进程由 Flask 同源托管，直接 fetch 请求即可。
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
  function getPlaybackStats(days = 30) {
    return jget(`/api/playback/stats?days=${days}`);
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
    getPlaybackStats,
    loadPlaylists,
    createPlaylist,
    deletePlaylist,
    getPlaylistSongs,
    exportPlaylist,
    importPlaylist,
  };
}
