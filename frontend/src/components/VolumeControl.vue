<template>
  <div class="volume-control">
    <button class="mute-btn" :title="player.muted ? '取消静音' : '静音'" @click="player.toggleMute()">
      <AppIcon :name="player.muted ? 'muted' : 'volume'" :size="18" />
    </button>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      :value="player.volume"
      @input="player.setVolume(parseFloat($event.target.value) || 0)"
    />
  </div>
</template>

<script setup>
import { usePlayerStore } from "@/stores/player";

const player = usePlayerStore();
</script>

<style scoped>
.volume-control {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 138px;
}
.mute-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast);
}
.mute-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--teyvat-text-primary);
}
.volume-control input[type="range"] {
  flex: 1;
  accent-color: var(--teyvat-gold);
  cursor: pointer;
}
</style>
