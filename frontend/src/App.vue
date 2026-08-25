<script setup>
import { onMounted, onBeforeUnmount, watch } from "vue";
import TheHeader from "@/components/TheHeader.vue";
import PlayerControls from "@/components/PlayerControls.vue";
import FullscreenPlayer from "@/components/FullscreenPlayer.vue";
import { usePlayerStore } from "@/stores/player";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistStore } from "@/stores/playlist";
import { useConfigStore } from "@/stores/config";
import { setupDesktopLyricsBridge } from "@/utils/desktopLyricsBridge";
import { setupMiniModeBridge } from "@/utils/miniModeBridge";
import { applyCustomFonts, setAppFont } from "@/utils/fonts";

const player = usePlayerStore();
const library = useLibraryStore();
const playlist = usePlaylistStore();
const config = useConfigStore();

let desktopBridgeStop = null;
let miniBridgeStop = null;
let watchFontsStop = null;

// 星尘粒子背景：App 挂载时初始化 Canvas，右/右下的星尘随机漂浮，不干扰 Vue 响应式更新。
// 性能优化：DPR 上限降到 1.5 减少像素量；窗口隐藏时暂停绘制；去掉逐粒子 shadowBlur 开销。
const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
let ctx = null;
let particles = [];
let rafId = 0;
let running = false;

function spawn(count) {
  const { width, height } = ctx.canvas;
  particles = [];
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      r: Math.random() * 1.6 + 0.4,
      vx: (Math.random() - 0.5) * 0.25,
      vy: -Math.random() * 0.18 - 0.06,
      alpha: Math.random() * 0.5 + 0.15,
      twinkle: Math.random() * Math.PI * 2,
    });
  }
}

function draw(tick) {
  if (document.hidden) {
    stopLoop();
    return;
  }
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    // 越界则回绕
    if (p.y < -8) { p.y = ctx.canvas.height + 8; p.x = Math.random() * ctx.canvas.width; }
    if (p.x < -8) p.x = ctx.canvas.width + 8;
    if (p.x > ctx.canvas.width + 8) p.x = -8;

    const fade = 0.6 + 0.4 * Math.sin(tick * 0.03 + p.twinkle);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 215, 107, ${p.alpha * fade})`;
    ctx.fill();
  }
  rafId = requestAnimationFrame(draw);
}

function startLoop() {
  if (running) return;
  running = true;
  rafId = requestAnimationFrame(draw);
}

function stopLoop() {
  running = false;
  cancelAnimationFrame(rafId);
}

function onVisibility() {
  if (document.hidden) stopLoop();
  else startLoop();
}

function initStardust() {
  const canvas = document.getElementById("stardust-bg");
  if (!canvas) return;
  ctx = canvas.getContext("2d");
  resizeCanvas();
  spawn(Math.min(Math.floor(ctx.canvas.width / 6), 140));
  startLoop();
}

function resizeCanvas() {
  if (!ctx) return;
  ctx.canvas.width = window.innerWidth * DPR;
  ctx.canvas.height = window.innerHeight * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

function onResize() {
  if (!ctx) return;
  resizeCanvas();
  spawn(Math.min(Math.floor(ctx.canvas.width / 6), 140));
}

onMounted(async () => {
  player.init();
  config.applyTheme();
  config.applyGlassFx();
  config.applyAccent();
  config.applyUiPrefs();
  // 构建音效链路（透明）并应用已保存的均衡器/预设状态
  config.pushAudioFx();
  // 应用设置面板里的音量与语速（播放模式由 player store 自行持久化，避免双数据源覆盖）
  player.setVolume(config.volume ?? player.volume);
  player.setPlaybackRate(config.playbackRate ?? 1);
  initStardust();
  setupMediaSession();
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onGlobalKey);
  document.addEventListener("visibilitychange", onVisibility);
  // 注册并应用已保存的自定义字体（含启动时界面字体）
  applyCustomFonts(config.customFonts);
  setAppFont(config.uiFontFamily);
  // 字体配置变化时即时生效
  watchFontsStop = watch(
    () => [config.uiFontFamily, config.customFonts],
    () => {
      applyCustomFonts(config.customFonts);
      setAppFont(config.uiFontFamily);
    },
    { deep: true }
  );
  // 全局快捷键开关变化时即时同步主进程（免重启）
  watch(
    () => config.globalHotkeys,
    (v) => applyGlobalHotkeys(v)
  );
  // 自定义主题主色 / 界面缩放 / 基准字号变化即时生效（免重启）
  watch(
    () => config.accentColor,
    (v) => config.setAccent(v)
  );
  watch(
    () => [config.uiScale, config.uiBaseFontSize],
    () => config.setUiPrefs()
  );
  // 桌面歌词广播桥接：把主窗口歌词状态实时转发给桌面歌词窗口
  desktopBridgeStop = setupDesktopLyricsBridge();
  // 迷你播放器小窗广播桥接：把主窗口播放状态实时转发给迷你小窗
  miniBridgeStop = setupMiniModeBridge();
  // 桌面歌词窗口通过 IPC 调用这些全局钩子控制播放
  window.__togglePlay = () => player.toggle();
  window.__prev = () => player.prev();
  window.__next = () => player.next();
  window.__seek = (t) => player.seek(t);
  // 应用系统级全局快捷键（后台遥控播放），并同步通知开关状态
  applyGlobalHotkeys(config.globalHotkeys);
  watchNotification();
  // 桌面歌词滚轮调字号：更新 clamp 到 16~40（与设置面板滑块一致）
  window.__setDlFontSize = (delta) => {
    const cur = Number(config.dlFontSize) || 24;
    config.dlFontSize = Math.max(16, Math.min(40, cur + delta));
  };
  // 加载曲库/播放列表后，按需恢复最近一次播放
  await Promise.all([library.load(), playlist.load()]);
  resumeLastPlayed();
});

/** 启动时继续播放：优先恢复上次播放队列（当前曲目进度由断点续播精确还原），否则回退到续播最近一首 */
function resumeLastPlayed() {
  if (!config.startupResume) return;
  if (config.resumeQueue && player.restoreQueue(library.songList)) {
    player._pendingRestore = true; // 仅启动续播恢复进度；之后切歌 / 选歌都从头播
    player.playQueue(player.queue, player.currentIndex);
    return;
  }
  const lastId = config.recentSongs[0];
  if (lastId == null) return;
  const song = library.songList.find((s) => s.id === lastId);
  if (!song) return;
  player._pendingRestore = true;
  player.playSong(song, library.songList);
}

/** 应用系统级全局快捷键：把当前开关状态同步到 Electron 主进程（后台也可遥控播放） */
function applyGlobalHotkeys(enabled) {
  const api = window.pywebview?.api;
  if (api && typeof api.applyGlobalHotkeys === "function") {
    try {
      api.applyGlobalHotkeys(!!enabled);
    } catch (_) {
      /* 忽略主进程不可用（纯浏览器环境） */
    }
  }
}

// 切歌系统通知：仅在开关开启时，切歌弹出系统通知（回调走主进程 Notification）
let notifiedSongId = null;
let watchNotifyStop = null;
function watchNotification() {
  watchNotifyStop = watch(
    () => player.currentSong?.id,
    (id) => {
      if (id == null || id === notifiedSongId) return;
      notifiedSongId = id;
      const api = window.pywebview?.api;
      if (config.songNotification && api && typeof api.notifySong === "function") {
        const song = player.currentSong;
        try {
          api.notifySong({
            title: song?.title || "",
            artist: song?.artist || "",
            songId: id,
          });
        } catch (_) {
          /* ignore */
        }
      }
    },
    { immediate: true }
  );
}

onBeforeUnmount(() => {
  stopLoop();
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", onGlobalKey);
  document.removeEventListener("visibilitychange", onVisibility);
  desktopBridgeStop?.();
  miniBridgeStop?.();
  watchFontsStop?.();
  watchNotifyStop?.();
  applyGlobalHotkeys(false);
  delete window.__togglePlay;
  delete window.__prev;
  delete window.__next;
  delete window.__seek;
  delete window.__setDlFontSize;
});

// ---- 全局快捷键 ----
const EDITABLE = ["INPUT", "TEXTAREA"];

function isEditable(target) {
  return EDITABLE.includes(target?.tagName) || target?.isContentEditable;
}

function onGlobalKey(e) {
  if (isEditable(e.target)) return;

  switch (e.code) {
    case "Escape":
      if (player.fullscreen) player.closeFullscreen();
      break;
    case "Space":
      e.preventDefault();
      player.toggle();
      break;
    case "ArrowRight":
      player.next();
      break;
    case "ArrowLeft":
      player.prev();
      break;
    case "ArrowUp": {
      // 避免与页面滚动/列表导航冲突，改为 Ctrl+↑ 调节音量
      if (!e.ctrlKey) return;
      e.preventDefault();
      player.setVolume(Math.min(player.volume + 0.1, 1));
      break;
    }
    case "ArrowDown": {
      // 避免与页面滚动/列表导航冲突，改为 Ctrl+↓ 调节音量
      if (!e.ctrlKey) return;
      e.preventDefault();
      player.setVolume(Math.max(player.volume - 0.1, 0));
      break;
    }
    case "MediaPlayPause":
      player.toggle();
      break;
    case "MediaTrackNext":
      player.next();
      break;
    case "MediaTrackPrevious":
      player.prev();
      break;
  }
}

// 媒体会话：让系统媒体键在外部环境也能控制
function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => player.toggle());
  navigator.mediaSession.setActionHandler("pause", () => player.toggle());
  navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
  navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
}
</script>

<template>
  <canvas id="stardust-bg" class="stardust-bg"></canvas>
  <div class="app-shell">
    <TheHeader />
    <router-view />
    <PlayerControls />
  </div>
  <FullscreenPlayer />
</template>
