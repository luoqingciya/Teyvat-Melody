// lastQueue：上次播放队列快照持久化（恢复「上次播放到哪」）。
// 仅存歌曲 id 序列 + 当前索引，启动时再映射回曲库中的歌曲，避免序列化整棵 Song 对象。
const KEY = "teyvat-melody.last-queue";

export function saveLastQueue(snapshot) {
  if (!snapshot || !snapshot.queueIds || !snapshot.queueIds.length) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch (_) {
    /* ignore quota / 序列化失败 */
  }
}

export function loadLastQueue() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function clearLastQueue() {
  localStorage.removeItem(KEY);
}
