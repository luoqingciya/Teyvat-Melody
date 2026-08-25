<template>
  <transition name="fs-fade">
    <div v-if="player.fullscreen" class="fullscreen-player" :style="fsFontVars" @click.self="player.closeFullscreen()">
      <!-- 顶部退出条 -->
      <div class="fs-topbar">
        <span class="fs-brand">{{ t("fs.brand") }}</span>
        <button class="fs-close" :title="t('player.exitFullscreen')" :aria-label="t('player.exitFullscreen')" @click="player.closeFullscreen()">
          <AppIcon name="x" :size="18" />
        </button>
      </div>

      <div class="fs-body">
        <!-- 左侧：旋转封面 + 歌曲信息 -->
        <div class="fs-left">
          <div class="fs-disc" :class="{ 'fs-disc--spin': player.isPlaying }">
            <img v-if="coverSrc" :src="coverSrc" class="fs-disc__img" :alt="t('song.coverAlt')" />
            <div v-else class="fs-disc__ph">
              <AppIcon name="music" :size="64" />
            </div>
          </div>
          <div class="fs-info">
            <h2 class="fs-title">{{ player.currentSong?.title || t("player.nowPlaying") }}</h2>
            <span class="fs-artist">{{ player.currentSong?.artist || t("player.selectSong") }}</span>
            <span class="fs-meta">
              {{ qualityLabel(player.currentSong) }}
              <span class="fs-meta__dot">·</span>
              {{ formatDuration(player.progress) }} / {{ formatDuration(player.duration) }}
            </span>
          </div>

          <!-- 控制：上一首 / 播放暂停 / 下一首 -->
          <div class="fs-controls">
            <button class="fs-ctrl" :title="t('player.prev')" :aria-label="t('player.prev')" @click="player.prev()"><AppIcon name="prev" :size="22" /></button>
            <button class="fs-play" :title="t('player.playPause')" :aria-label="t('player.playPause')" :aria-pressed="player.isPlaying" @click="player.toggle()">
              <AppIcon :name="player.isPlaying ? 'pause' : 'play'" :size="26" />
            </button>
            <button class="fs-ctrl" :title="t('player.next')" :aria-label="t('player.next')" @click="player.next()"><AppIcon name="next" :size="22" /></button>
          </div>
        </div>

      <!-- 右侧：歌词滚动 -->
      <div class="fs-lyrics">
        <LyricsPanel :lines="player.lyrics" :current-time="player.progress" :offset="config.lyricOffset" />
      </div>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";
import LyricsPanel from "./LyricsPanel.vue";
import { usePlayerStore } from "@/stores/player";
import { useConfigStore } from "@/stores/config";
import { useI18n } from "@/utils/i18n";

const player = usePlayerStore();
const config = useConfigStore();
const { t } = useI18n();

const fsFontVars = computed(() => {
  const style = {};
  // 未单独指定全屏歌词字体时，回退到界面字体（含自定义字体）
  const fam = config.fsFontFamily || "var(--app-font-family)";
  style["--fs-font-family"] = fam;
  if (config.fsFontSize > 0) style["--fs-font-size"] = `${config.fsFontSize}px`;
  return style;
});

const coverSrc = computed(() => {
  const song = player.currentSong;
  if (!song) return "";
  return song.has_cover ? `/api/songs/${song.id}/cover` : "";
});

function formatDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function qualityLabel(song) {
  if (!song) return "";
  const parts = [];
  if (song.format) parts.push(String(song.format).toUpperCase());
  if (song.bitrate) parts.push(`${Math.round(song.bitrate)}k`);
  if (song.sample_rate) parts.push(`${(song.sample_rate / 1000).toFixed(1)}kHz`);
  return parts.join(" · ");
}
</script>

<style scoped>
.fullscreen-player {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  font-family: var(--fs-font-family, inherit);
  background: radial-gradient(1200px 800px at 20% 10%, color-mix(in srgb, var(--teyvat-blue) 16%, transparent), transparent 60%),
    radial-gradient(1000px 700px at 85% 85%, color-mix(in srgb, var(--teyvat-gold) 14%, transparent), transparent 60%),
    var(--teyvat-bg-dark);
}

.fs-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) 22px;
}
.fs-brand {
  font-size: 13px;
  letter-spacing: 2px;
  color: var(--teyvat-text-secondary);
}
.fs-close {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--teyvat-text-primary) 6%, transparent);
  color: var(--teyvat-text-primary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--t-fast);
}
.fs-close:hover {
  background: color-mix(in srgb, var(--teyvat-text-primary) 14%, transparent);
}

.fs-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(48px, 10vw, 160px);
  padding: var(--space-6) 48px 48px;
}

.fs-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 26px;
  flex-shrink: 0;
  width: clamp(300px, 34vw, 520px);
}
.fs-disc {
  width: 100%;
  aspect-ratio: 1;
  max-width: 440px;
  border-radius: var(--radius-full);
  overflow: hidden;
  border: 12px solid color-mix(in srgb, var(--teyvat-text-primary) 6%, transparent);
  box-shadow: var(--shadow-pop);
  background: color-mix(in srgb, var(--teyvat-text-primary) 4%, transparent);
}
.fs-disc--spin {
  animation: fs-spin 20s linear infinite;
}
.fs-disc__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.fs-disc__ph {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--teyvat-gold);
  opacity: 0.6;
}
@keyframes fs-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.fs-info {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.fs-title {
  margin: 0;
  font-size: clamp(calc(var(--fs-font-size, 16px) * 1.35), 2.8vw, 36px);
  color: var(--teyvat-text-primary);
}
.fs-artist {
  font-size: calc(var(--fs-font-size, 16px) * 0.95);
  color: var(--teyvat-text-secondary);
}
.fs-meta {
  font-size: 13px;
  color: var(--teyvat-gold);
  letter-spacing: 1px;
}
.fs-meta__dot {
  color: var(--teyvat-text-secondary);
}

.fs-controls {
  display: flex;
  align-items: center;
  gap: 26px;
}
.fs-ctrl {
  width: 52px;
  height: 52px;
  border: none;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--teyvat-text-primary) 6%, transparent);
  color: var(--teyvat-text-primary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--t-fast), transform var(--t-fast);
}
.fs-ctrl:hover {
  background: color-mix(in srgb, var(--teyvat-text-primary) 14%, transparent);
}
.fs-play {
  width: 70px;
  height: 70px;
  border: none;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--teyvat-gold), var(--teyvat-gold-2));
  color: #1a1424;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 28px color-mix(in srgb, var(--teyvat-gold) 40%, transparent);
  transition: transform var(--t-fast), box-shadow var(--t-fast);
}
.fs-play:hover {
  transform: scale(1.06);
}
.fs-play:active {
  transform: scale(0.95);
}

.fs-lyrics {
  flex: 1;
  max-width: 680px;
  min-width: 0;
  font-size: var(--fs-font-size, 16px);
}
.fs-lyrics :deep(.lyrics-panel) {
  height: 68vh;
  min-height: 420px;
}
.fs-lyrics :deep(.lyrics-line) {
  font-size: 1em;
  line-height: 1.7;
  height: 2.9em;
  line-height: 2.9em;
}
.fs-lyrics :deep(.lyrics-panel__empty) {
  font-size: 1em;
}

.fs-fade-enter-active,
.fs-fade-leave-active {
  transition: opacity var(--t-base);
}
.fs-fade-enter-from,
.fs-fade-leave-to {
  opacity: 0;
}
</style>