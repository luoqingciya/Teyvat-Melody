<template>
  <aside class="player-panel">
    <GlassCard class="player-panel__card">
      <!-- 专辑封面（点击进入全屏播放） -->
      <div class="player-panel__art" :title="t('player.fullscreen')" :aria-label="t('player.fullscreen')" role="button" tabindex="0" @click="player.openFullscreen()" @keyup.enter="player.openFullscreen()">
        <AlbumArt :src="coverSrc" />
        <span class="player-panel__art-hint">
          <AppIcon name="expand" :size="18" />
        </span>
      </div>

      <!-- 当前歌曲信息 -->
      <div class="player-info">
        <h3 class="player-info__title">{{ player.currentSong?.title || t("player.nowPlaying") }}</h3>
        <span class="player-info__artist">{{ player.currentSong?.artist || t("player.selectSong") }}</span>
      </div>

      <!-- 歌词面板（LRC 滚动高亮） -->
      <LyricsPanel class="player-panel__lyrics" :lines="lines" :current-time="player.progress" :offset="config.lyricOffset" />
    </GlassCard>
  </aside>
</template>

<script setup>
import { computed } from "vue";
import GlassCard from "./GlassCard.vue";
import AlbumArt from "./AlbumArt.vue";
import LyricsPanel from "./LyricsPanel.vue";
import AppIcon from "./AppIcon.vue";
import { usePlayerStore } from "@/stores/player";
import { useConfigStore } from "@/stores/config";
import { useI18n } from "@/utils/i18n";

const player = usePlayerStore();
const config = useConfigStore();
const { t } = useI18n();
// 歌词统一来自 player store（切换歌曲时由 store 负责拉取与记录最近播放）
const lines = computed(() => player.lyrics);

// 有内嵌封面时指向封面接口
const coverSrc = computed(() => {
  const song = player.currentSong;
  if (!song) return "";
  return song.has_cover ? `/api/songs/${song.id}/cover` : "";
});
</script>

<style scoped>
.player-panel {
  width: 300px;
  flex-shrink: 0;
  height: 100%;
  min-height: 0;
}
.player-panel :deep(.glass-card) {
  height: 100%;
  min-height: 0;
}
.player-panel :deep(.glass-card__body) {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.player-panel__card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
  min-height: 0;
}
.player-panel__art {
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  border-radius: 14px;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}
.player-panel__art:hover {
  transform: scale(1.02);
  box-shadow: 0 8px 30px rgba(255, 215, 107, 0.18);
}
.player-panel__art-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 14, 26, 0.45);
  color: var(--teyvat-gold);
  opacity: 0;
  transition: opacity 0.2s;
}
.player-panel__art:hover .player-panel__art-hint,
.player-panel__art:focus-visible .player-panel__art-hint {
  opacity: 1;
}
.player-panel__lyrics {
  flex: 1;
  min-height: 0;
  height: auto !important;
}
.player-info {
  text-align: center;
  flex-shrink: 0;
  padding-bottom: 6px;
}
.player-info__title {
  font-size: 16px;
  color: var(--teyvat-text-primary);
}
.player-info__artist {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
</style>
