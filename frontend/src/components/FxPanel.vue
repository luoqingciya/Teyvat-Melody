<template>
  <div class="fx-panel">
    <div class="fx-panel__head">
      <span class="fx-panel__title">音效</span>
      <label class="fx-panel__switch">
        <input
          type="checkbox"
          :checked="config.audioFxEnabled"
          @change="toggleEnabled($event.target.checked)"
        />
        <span class="fx-panel__slider"></span>
        <span class="fx-panel__switch-label">{{ config.audioFxEnabled ? "已开启" : "已关闭" }}</span>
      </label>
    </div>

    <div class="fx-panel__presets">
      <button
        v-for="p in presetList"
        :key="p.key"
        class="fx-preset"
        :class="{ 'fx-preset--on': config.eqPreset === p.key }"
        @click="selectPreset(p.key)"
      >
        {{ p.label }}
      </button>
    </div>

    <div class="fx-eq">
      <div v-for="(freq, i) in EQ_FREQS" :key="freq" class="fx-eq__band">
        <input
          class="fx-eq__slider"
          type="range"
          min="-12"
          max="12"
          step="1"
          :value="displayBands[i]"
          @input="onBandInput(i, parseFloat($event.target.value))"
        />
        <span class="fx-eq__val">{{ displayBands[i] > 0 ? "+" : "" }}{{ displayBands[i] }}</span>
        <span class="fx-eq__freq">{{ freq >= 1000 ? freq / 1000 + "k" : freq }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, watch } from "vue";
import { useConfigStore } from "@/stores/config";
import { EQ_FREQS, EQ_PRESETS } from "@/utils/audioFx";

const config = useConfigStore();

const presetList = [
  { key: "flat", label: "原声" },
  { key: "bass", label: "重低音" },
  { key: "vocal", label: "清澈人声" },
  { key: "live", label: "现场" },
  { key: "game", label: "游戏" },
  { key: "classic", label: "古典" },
  { key: "pop", label: "流行" },
  { key: "custom", label: "自定义" },
];

// 滑块展示值：自定义跟随 eqBands，其余跟随预设曲线
const displayBands = computed(() => {
  if (config.eqPreset === "custom") return config.eqBands;
  return EQ_PRESETS[config.eqPreset] || EQ_PRESETS.flat;
});

function toggleEnabled(on) {
  config.audioFxEnabled = on;
  apply();
}

function selectPreset(key) {
  config.eqPreset = key;
  if (key !== "custom") {
    // 把预设曲线写入 eqBands，使滑块同步展示
    config.eqBands = [...(EQ_PRESETS[key] || EQ_PRESETS.flat)];
  }
  config.audioFxEnabled = true;
  apply();
}

function onBandInput(i, val) {
  const bands = [...config.eqBands];
  bands[i] = val;
  config.eqBands = bands;
  config.eqPreset = "custom";
  config.audioFxEnabled = true;
  apply();
}

function apply() {
  config.pushAudioFx();
}

// 状态被外部（如启动时恢复）影响时也同步到音频图
watch(
  () => [config.audioFxEnabled, config.eqPreset, config.eqBands],
  () => apply(),
  { deep: true }
);
</script>

<style scoped>
.fx-panel {
  width: 380px;
  max-width: 92vw;
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px solid var(--teyvat-card-border);
  /* 用高不透明度的深色底混合卡片色，替代纯 card-bg（alpha 0.55 太透），保证面板内文字清晰可读 */
  background: color-mix(in srgb, var(--teyvat-card-bg) 24%, var(--teyvat-bg-dark) 76%);
  backdrop-filter: blur(var(--blur-overlay)) saturate(140%);
  box-shadow: var(--shadow-pop);
  color: var(--teyvat-text-primary);
}

.fx-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}
.fx-panel__title {
  font-size: 15px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 1px;
}
.fx-panel__switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.fx-panel__switch input {
  display: none;
}
.fx-panel__slider {
  position: relative;
  width: 38px;
  height: 20px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--teyvat-text-secondary) 26%, transparent);
  transition: background var(--t-base);
  flex-shrink: 0;
}
.fx-panel__slider::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--teyvat-text-primary);
  transition: transform var(--t-base);
}
.fx-panel__switch input:checked + .fx-panel__slider {
  background: var(--teyvat-gold);
}
.fx-panel__switch input:checked + .fx-panel__slider::after {
  transform: translateX(18px);
}

.fx-panel__presets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.fx-preset {
  padding: 5px var(--space-3);
  border: 1px solid var(--teyvat-card-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--teyvat-text-primary) 7%, transparent);
  color: var(--teyvat-text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--t-fast), border-color var(--t-fast), color var(--t-fast);
}
.fx-preset:hover {
  background: color-mix(in srgb, var(--teyvat-text-primary) 13%, transparent);
}
.fx-preset--on {
  border-color: var(--teyvat-gold);
  color: var(--teyvat-gold);
  background: color-mix(in srgb, var(--teyvat-gold) 16%, transparent);
}

.fx-eq {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--teyvat-card-border);
}
.fx-eq__band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
}
.fx-eq__slider {
  /* 垂直滑块：用 writing-mode 实现（appearance: slider-vertical 已废弃） */
  writing-mode: vertical-lr;
  direction: rtl;
  width: var(--space-2);
  height: 120px;
  accent-color: var(--teyvat-gold);
  cursor: pointer;
}
.fx-eq__val {
  font-size: 10px;
  color: var(--teyvat-text-secondary);
}
.fx-eq__freq {
  font-size: 10px;
  color: var(--teyvat-text-secondary);
}
</style>
