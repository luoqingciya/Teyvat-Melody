<template>
  <button class="play-button" :title="player.isPlaying ? '暂停' : '播放'" @click="toggle">
    <AppIcon :name="player.isPlaying ? 'pause' : 'play'" :size="22" />
  </button>
</template>

<script setup>
import { usePlayerStore } from "@/stores/player";

const player = usePlayerStore();

function toggle() {
  player.toggle();
}
</script>

<style scoped>
.play-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border: none;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--teyvat-gold), var(--teyvat-gold-2));
  color: #1a1424;
  cursor: pointer;
  transition: transform var(--t-base), box-shadow var(--t-base), filter var(--t-base);
  box-shadow: 0 4px 16px color-mix(in srgb, var(--teyvat-gold) 30%, transparent);
}
.play-button:hover {
  transform: scale(1.06);
  filter: brightness(1.05);
  box-shadow: 0 6px 22px color-mix(in srgb, var(--teyvat-gold) 42%, transparent);
}
.play-button:active {
  transform: scale(0.95);
}
</style>
