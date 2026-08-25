<template>
  <div class="progress-bar">
    <input
      type="range"
      :min="0"
      :max="max || 0"
      step="0.1"
      :value="value || 0"
      :disabled="!max"
      @input="onInput"
    />
  </div>
</template>

<script setup>
const props = defineProps({
  value: { type: Number, default: 0 },
  max: { type: Number, default: 0 },
});
const emit = defineEmits(["seek"]);

function onInput(e) {
  emit("seek", parseFloat(e.target.value));
}
</script>

<style scoped>
.progress-bar {
  flex: 1;
  display: flex;
  align-items: center;
}
.progress-bar input[type="range"] {
  width: 100%;
  height: 4px;
  accent-color: var(--teyvat-gold);
  cursor: pointer;
}
.progress-bar input[type="range"]::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--teyvat-text-secondary) 28%, transparent);
}
.progress-bar input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4px;
  border-radius: var(--radius-full);
  background: var(--teyvat-gold);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--teyvat-gold) 20%, transparent);
  transition: transform var(--t-fast);
}
.progress-bar input[type="range"]::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}
.progress-bar input[type="range"]:disabled {
  cursor: default;
}
</style>
