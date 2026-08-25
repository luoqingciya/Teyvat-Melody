<template>
  <div class="queue-panel">
    <div class="queue-panel__head">
      <span class="queue-panel__title">播放队列（{{ player.queue.length }}）</span>
      <button
        class="queue-panel__clear"
        title="清空队列"
        :disabled="!player.queue.length"
        @click="player.clearQueue()"
      >
        <AppIcon name="trash" :size="14" />
      </button>
    </div>

    <div v-if="!player.queue.length" class="queue-panel__empty">队列为空</div>

    <div v-else class="queue-panel__list">
      <div
        v-for="(song, i) in player.queue"
        :key="song.id + '-' + i"
        class="queue-row"
        :class="{ 'queue-row--active': i === player.currentIndex }"
        @click="player.jumpTo(i)"
      >
        <span class="queue-row__idx">
          <AppIcon v-if="i === player.currentIndex" name="check" :size="13" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="queue-row__meta">
          <span class="queue-row__title" :title="song.title">{{ song.title }}</span>
          <span class="queue-row__artist" :title="song.artist">{{ song.artist || "未知" }}</span>
        </span>
        <span class="queue-row__duration">{{ formatDuration(song.duration) }}</span>
        <button
          class="queue-row__remove"
          title="从队列移除"
          @click.stop="player.removeFromQueue(i)"
        >
          <AppIcon name="x" :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import AppIcon from "./AppIcon.vue";
import { usePlayerStore } from "@/stores/player";

const player = usePlayerStore();

function formatDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
</script>

<style scoped>
.queue-panel {
  width: 300px;
  max-height: 360px;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  border: 1px solid var(--teyvat-card-border);
  background: color-mix(in srgb, var(--teyvat-card-bg) 100%, transparent);
  backdrop-filter: blur(var(--blur-overlay));
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.queue-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4) var(--space-2);
  border-bottom: 1px solid var(--teyvat-card-border);
}
.queue-panel__title {
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 1px;
  color: var(--teyvat-text-primary);
}
.queue-panel__clear {
  border: none;
  background: transparent;
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  transition: color var(--t-fast), background var(--t-fast);
}
.queue-panel__clear:hover:not(:disabled) {
  color: var(--teyvat-danger);
  background: color-mix(in srgb, var(--teyvat-danger) 12%, transparent);
}
.queue-panel__clear:disabled {
  opacity: 0.35;
  cursor: default;
}
.queue-panel__empty {
  text-align: center;
  color: var(--teyvat-text-secondary);
  font-size: 13px;
  padding: var(--space-7) 0;
}
.queue-panel__list {
  overflow-y: auto;
  max-height: 300px;
}
.queue-panel__list::-webkit-scrollbar {
  width: var(--space-2);
}
.queue-panel__list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--teyvat-text-secondary) 36%, transparent);
  border-radius: var(--radius-full);
}
.queue-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  transition: background var(--t-fast);
}
.queue-row:hover {
  background: color-mix(in srgb, var(--teyvat-card-bg) 10%, transparent);
}
.queue-row--active {
  background: linear-gradient(90deg, color-mix(in srgb, var(--teyvat-gold) 14%, transparent), transparent);
}
.queue-row--active .queue-row__title {
  color: var(--teyvat-gold);
}
.queue-row__idx {
  width: var(--space-5);
  flex-shrink: 0;
  font-size: 12px;
  color: var(--teyvat-text-secondary);
  display: inline-flex;
  justify-content: center;
}
.queue-row--active .queue-row__idx {
  color: var(--teyvat-gold);
}
.queue-row__meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.queue-row__title {
  font-size: 13px;
  color: var(--teyvat-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.queue-row__artist {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.queue-row__duration {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.queue-row__remove {
  border: none;
  background: transparent;
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
  display: inline-flex;
  opacity: 0;
  transition: color var(--t-fast), opacity var(--t-fast);
}
.queue-row:hover .queue-row__remove {
  opacity: 0.7;
}
.queue-row__remove:hover {
  color: var(--teyvat-danger);
  opacity: 1;
}
</style>
