// 迷你播放器广播桥接：仅在主窗口启用，把播放状态实时推送给 Electron 迷你小窗。
// 采用「全量（歌曲信息）+ 增量（进度/播放态）」双通道，与桌面歌词桥保持一致的模式。
import { watch } from "vue";
import { usePlayerStore } from "@/stores/player";

export function setupMiniModeBridge() {
  const player = usePlayerStore();
  let stop = null;
  let readyTimer = null;
  let progressTimer = null;

  function buildSnapshot() {
    const song = player.currentSong;
    // 迷你小窗加载自 file://，封面需使用后端绝对地址（主窗口同源 http://127.0.0.1:5000）。
    const origin = window.location.origin || "http://127.0.0.1:5000";
    return {
      title: song?.title || "",
      artist: song?.artist || "",
      cover: song && song.has_cover ? `${origin}/api/songs/${song.id}/cover` : "",
      isPlaying: player.isPlaying,
      progress: player.progress,
      duration: player.duration,
    };
  }

  function canPush() {
    const api = window.pywebview?.api;
    return api && typeof api.pushMiniState === "function";
  }

  function push() {
    if (!canPush()) return;
    // Electron IPC 用结构化克隆，Vue reactive 代理对象无法克隆，须先 JSON 序列化。
    window.pywebview.api.pushMiniState(JSON.parse(JSON.stringify(buildSnapshot())));
  }

  function init() {
    if (!canPush()) return false;

    // 全量通道：歌曲切换 / 播放态变化 / 时长变化时推送完整快照。
    stop = watch(
      () => [player.currentSong?.id, player.isPlaying, player.duration],
      () => push(),
      { immediate: true }
    );

    // 进度轮询：驱动进度条平滑推进（500ms 足够）。
    progressTimer = setInterval(() => push(), 500);
    return true;
  }

  // pywebview 就绪后立即建立监听；轮询兜底，防止就绪事件已错过。
  if (!init()) {
    readyTimer = setInterval(() => {
      if (init()) clearInterval(readyTimer);
    }, 300);
  }

  return () => {
    stop?.();
    if (readyTimer) clearInterval(readyTimer);
    if (progressTimer) clearInterval(progressTimer);
  };
}
