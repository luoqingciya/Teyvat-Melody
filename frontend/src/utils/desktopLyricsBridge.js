// 桌面歌词广播桥接：仅在主窗口中启用。
// 采用「全量 + 增量」双通道：
//   - 全量（歌词内容/颜色/外观/模式）：在歌曲切换、歌词变更、设置变更、初始就绪时推送。
//   - 增量（activeIndex/isPlaying/progress）：行推进、播放/暂停、进度轮询时只推轻量字段。
// 主进程把增量合并进 lastLyrics，桌面歌词子窗口据此实时渲染，避免每次携带整份歌词数组。
import { watch } from "vue";
import { usePlayerStore } from "@/stores/player";
import { useConfigStore } from "@/stores/config";

export function setupDesktopLyricsBridge() {
  const player = usePlayerStore();
  const config = useConfigStore();
  let stop = null;
  let stopIncremental = null;
  let readyTimer = null;
  let progressTimer = null;

  function buildFullPayload() {
    return {
      title: player.currentSong?.title || "",
      artist: player.currentSong?.artist || "",
      lines: player.lyrics,
      activeIndex: player.activeLyricIndex,
      isPlaying: player.isPlaying,
      progress: player.progress, // 秒：供进度条 / 逐字高亮使用
      duration: player.duration, // 秒：进度条总量
      colors: { text: config.dlTextColor, active: config.dlActiveColor },
      appearance: {
        fontSize: config.dlFontSize,
        fontFamily: config.dlFontFamily,
        bgMode: config.dlBgMode,
      },
      options: {
        karaokeMode: config.dlKaraokeMode,
        lineMode: config.dlLineMode,
        showProgress: config.dlShowProgress,
        showTranslation: config.showTranslation,
        lyricOffset: config.lyricOffset,
      },
    };
  }

  function canPush() {
    const api = window.pywebview?.api;
    return api && typeof api.pushDesktopLyrics === "function";
  }

  function pushFull() {
    if (!canPush()) return;
    // 深拷贝为普通对象再推送：Electron IPC 用结构化克隆，Vue 的 reactive 代理对象
    // 无法被克隆（会抛 "An object could not be cloned"）。JSON 序列化对 reactive 透明。
    window.pywebview.api.pushDesktopLyrics(JSON.parse(JSON.stringify(buildFullPayload())));
  }

  function pushIncremental() {
    if (!canPush()) return;
    window.pywebview.api.pushDesktopLyrics(
      JSON.parse(
        JSON.stringify({
          activeIndex: player.activeLyricIndex,
          isPlaying: player.isPlaying,
          progress: player.progress,
        })
      )
    );
  }

  function init() {
    if (!canPush()) return false;

    // 全量通道：歌曲/歌词内容或设置变化时推送完整载荷。
    stop = watch(
      () => [
        player.currentSong?.id,
        player.lyrics,
        config.dlTextColor,
        config.dlActiveColor,
        config.dlFontSize,
        config.dlFontFamily,
        config.dlBgMode,
        config.dlKaraokeMode,
        config.dlLineMode,
        config.dlShowProgress,
        config.showTranslation,
        config.lyricOffset,
      ],
      () => pushFull(),
      { deep: true, immediate: true }
    );

    // 增量通道：行推进 / 播放态变化立即推轻量载荷（进度条由 interval 兜底）。
    // 用字符串键聚合，避免 getter 每次返回新数组导致 watch 在每个 timeupdate 都被误触发。
    stopIncremental = watch(
      () => `${player.activeLyricIndex}:${player.isPlaying}`,
      () => pushIncremental(),
      { immediate: false }
    );

    // 播放进度轮询：驱动进度条 / 逐字高亮（500ms 足够平滑）
    progressTimer = setInterval(() => pushIncremental(), 500);
    return true;
  }

  // pywebview 就绪后立即建立监听；轮询兜底，防止 pywebviewready 事件已错过。
  if (!init()) {
    readyTimer = setInterval(() => {
      if (init()) clearInterval(readyTimer);
    }, 300);
  }

  return () => {
    stop?.();
    stopIncremental?.();
    if (readyTimer) clearInterval(readyTimer);
    if (progressTimer) clearInterval(progressTimer);
  };
}
