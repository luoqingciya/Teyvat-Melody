// playbackProgress：按歌曲记忆/恢复播放进度（断点续播精确到秒）。
// 独立于 pinia 持久化：进度更新频率高，单独用 localStorage key 存储，
// 并做节流写入，避免频繁序列化整个 config store。
const KEY = "teyvat-melody.song-progress";

// 内存缓存：songId -> { t: 秒, lastWritten: 秒 }，减少重复解析/写入
const cache = new Map();

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 配额异常等；忽略以免中断播放
  }
}

/** 读取某首歌曲已记忆的进度（秒）；无则返回 0 */
export function getProgress(songId) {
  if (songId == null) return 0;
  const cached = cache.get(songId);
  if (cached !== undefined) return cached;
  const val = readAll()[String(songId)] || 0;
  cache.set(songId, val);
  return val;
}

/** 保存进度；跨整秒才真正落盘（节流），尽可能与界面进度保持一致 */
export function saveProgress(songId, seconds) {
  if (songId == null) return;
  const t = Number(seconds) || 0;
  // 累计不足 1 秒的更新直接跳过，避免高频写
  const cur = Math.floor(t);
  const cached = cache.get(songId);
  if (cached === cur) return;
  cache.set(songId, cur);
  const map = readAll();
  map[String(songId)] = cur;
  writeAll(map);
}

/** 清除某首歌曲的进度（自然播放结束/用户重置时用） */
export function clearProgress(songId) {
  if (songId == null) return;
  cache.delete(songId);
  const map = readAll();
  if (songId in map) {
    delete map[String(songId)];
    writeAll(map);
  }
}
