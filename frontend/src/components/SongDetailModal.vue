<template>
  <AppModal :model-value="visible" :title="song?.title || '歌曲详情'" :width="440" @update:model-value="close">
    <div v-if="song" class="song-detail">
      <div class="song-detail__hero">
        <div class="song-detail__cover">
          <AlbumArt :src="coverSrc" />
        </div>
        <div class="song-detail__head-info">
          <h3 class="song-detail__title">{{ song.title }}</h3>
          <p class="song-detail__artist">{{ song.artist || "未知艺术家" }}</p>
        </div>
      </div>

      <div class="song-detail__rows">
        <div class="song-detail__row">
          <span class="song-detail__label">专辑</span>
          <span class="song-detail__value">{{ song.album || "—" }}</span>
        </div>
        <div class="song-detail__row">
          <span class="song-detail__label">时长</span>
          <span class="song-detail__value">{{ formatDuration(song.duration) }}</span>
        </div>
        <div class="song-detail__row">
          <span class="song-detail__label">音质</span>
          <span class="song-detail__value">{{ qualityLabel(song) }}</span>
        </div>
        <div class="song-detail__row">
          <span class="song-detail__label">声道</span>
          <span class="song-detail__value">{{ channelsLabel(song) }}</span>
        </div>
        <div class="song-detail__row">
          <span class="song-detail__label">路径</span>
          <span class="song-detail__value song-detail__value--path" :title="song.path">{{ song.path || "—" }}</span>
        </div>
      </div>

      <div class="song-detail__actions">
        <button class="song-detail__btn ui-btn" @click="$emit('play')">
          <AppIcon name="play" :size="15" />
          <span>播放</span>
        </button>
        <button class="song-detail__btn ui-btn ui-btn--ghost" @click="$emit('toggle-fav')">
          <AppIcon :name="song.favorite ? 'heart' : 'heart-outline'" :size="15" />
          <span>{{ song.favorite ? "取消收藏" : "收藏" }}</span>
        </button>
      </div>
    </div>
  </AppModal>
</template>

<script setup>
import { computed } from "vue";
import AppModal from "./AppModal.vue";
import AlbumArt from "./AlbumArt.vue";
import AppIcon from "./AppIcon.vue";

const props = defineProps({
  visible: { type: Boolean, default: false },
  song: { type: Object, default: null },
});
const emit = defineEmits(["close", "play", "toggle-fav"]);

const coverSrc = computed(() => {
  const song = props.song;
  if (!song) return "";
  return song.has_cover ? `/api/songs/${song.id}/cover` : "";
});

function formatDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function qualityLabel(song) {
  const parts = [];
  if (song.format) parts.push(String(song.format).toUpperCase());
  if (song.bitrate) parts.push(`${Math.round(song.bitrate)}k`);
  if (song.sample_rate) parts.push(`${(song.sample_rate / 1000).toFixed(1)}kHz`);
  return parts.join(" · ") || "未知";
}

function channelsLabel(song) {
  const c = Number(song.channels) || 0;
  if (!c) return "未知";
  return c === 1 ? "单声道" : c === 2 ? "双声道" : c === 6 ? "5.1" : `${c} 声道`;
}

function close(v) {
  emit("close", v);
}
</script>

<style scoped>
.song-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.song-detail__hero {
  display: flex;
  gap: var(--space-4);
  align-items: center;
}
.song-detail__cover {
  width: 92px;
  flex-shrink: 0;
}
.song-detail__head-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.song-detail__title {
  font-size: 17px;
  color: var(--teyvat-text-primary);
  font-weight: var(--font-weight-semibold);
  line-height: 1.3;
  word-break: break-all;
}
.song-detail__artist {
  font-size: 13px;
  color: var(--teyvat-text-secondary);
}
.song-detail__rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.song-detail__row {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--teyvat-card-border);
  font-size: 13px;
}
.song-detail__label {
  width: 48px;
  flex-shrink: 0;
  color: var(--teyvat-text-secondary);
}
.song-detail__value {
  flex: 1;
  color: var(--teyvat-text-primary);
  min-width: 0;
  word-break: break-all;
}
.song-detail__value--path {
  color: var(--teyvat-text-secondary);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.song-detail__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-1);
}
</style>
