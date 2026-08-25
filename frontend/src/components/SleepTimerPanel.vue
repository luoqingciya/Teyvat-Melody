<template>
  <div class="sleep-panel">
    <div class="sleep-panel__head">
      <span class="sleep-panel__title">睡眠定时</span>
    </div>

    <button
      class="sleep-option"
      :class="{ 'sleep-option--active': !player.sleep }"
      @click="choose(null)"
    >
      <AppIcon name="moon" :size="15" />
      <span>关闭定时</span>
      <AppIcon v-if="!player.sleep" name="check" :size="15" class="sleep-option__check" />
    </button>

    <button
      class="sleep-option"
      :class="{ 'sleep-option--active': player.sleep?.mode === 'track' }"
      @click="choose({ mode: 'track' })"
    >
      <AppIcon name="moon-pause" :size="15" />
      <span>播完本曲停止</span>
      <AppIcon v-if="player.sleep?.mode === 'track'" name="check" :size="15" class="sleep-option__check" />
    </button>

    <div class="sleep-panel__divider" />

    <button
      v-for="m in MINUTES"
      :key="m"
      class="sleep-option"
      :class="{ 'sleep-option--active': player.sleep?.mode === 'minutes' && player.sleep.minutes === m }"
      @click="choose({ mode: 'minutes', minutes: m })"
    >
      <AppIcon name="moon" :size="15" />
      <span>{{ m }} 分钟后停止</span>
      <AppIcon
        v-if="player.sleep?.mode === 'minutes' && player.sleep.minutes === m"
        name="check"
        :size="15"
        class="sleep-option__check"
      />
    </button>
  </div>
</template>

<script setup>
import AppIcon from "./AppIcon.vue";
import { usePlayerStore } from "@/stores/player";

const player = usePlayerStore();
const MINUTES = [10, 20, 30, 45, 60, 90];

function choose(opt) {
  player.setSleep(opt);
}
</script>

<style scoped>
.sleep-panel {
  width: 240px;
  max-height: 340px;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  border: 1px solid var(--teyvat-card-border);
  background: color-mix(in srgb, var(--teyvat-card-bg) 24%, var(--teyvat-bg-dark) 76%);
  backdrop-filter: blur(var(--blur-overlay));
  box-shadow: var(--shadow-pop);
  overflow-y: auto;
  padding: var(--space-2);
}
.sleep-panel::-webkit-scrollbar {
  width: var(--space-2);
}
.sleep-panel::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--teyvat-text-secondary) 36%, transparent);
  border-radius: var(--radius-full);
}
.sleep-panel__head {
  padding: var(--space-2) var(--space-3) var(--space-2);
}
.sleep-panel__title {
  font-size: 12px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 1px;
  color: var(--teyvat-text-secondary);
}
.sleep-panel__divider {
  height: 1px;
  margin: var(--space-1) var(--space-2);
  background: var(--teyvat-card-border);
}
.sleep-option {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: var(--teyvat-text-primary);
  font-size: 13px;
  text-align: left;
  transition: background var(--t-fast);
}
.sleep-option:hover {
  background: color-mix(in srgb, var(--teyvat-card-bg) 10%, transparent);
}
.sleep-option--active {
  color: var(--teyvat-gold);
}
.sleep-option__check {
  margin-left: auto;
  color: var(--teyvat-gold);
}
</style>
