<template>
  <div class="lyrics-panel">
    <div ref="viewport" class="lyrics-panel__viewport">
      <div
        class="lyrics-panel__track"
        :style="{ transform: `translateY(${offset}px)` }"
      >
        <div
          v-for="(row, i) in rows"
          :key="i"
          class="lyrics-line-wrap"
          :class="{ 'lyrics-line-wrap--active': i === activeIndex }"
          :style="{ height: LINE_HEIGHT + 'px' }"
        >
          <p class="lyrics-line">{{ row.main }}</p>
          <p v-if="i === activeIndex && row.sub" class="lyrics-sub">{{ row.sub }}</p>
        </div>
      </div>
    </div>
    <p v-if="!rows.length" class="lyrics-panel__empty">{{ t("song.noLyrics") }}</p>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { useConfigStore } from "@/stores/config";
import { useI18n } from "@/utils/i18n";

const props = defineProps({
  lines: { type: Array, default: () => [] },
  currentTime: { type: Number, default: 0 },
  // 歌词偏移（毫秒），与桌面歌词/播放器 store 的 lyricOffset 保持一致
  offset: { type: Number, default: 0 },
});

const config = useConfigStore();
const { t } = useI18n();

const LINE_HEIGHT = 46; // 每行歌词高度（px，含可能的翻译副行）
const viewport = ref(null);
const viewportHeight = ref(0);

// 把行文本拆分为主歌词 + 翻译/副歌词（与桌面歌词的 splitMainSub 保持一致的分隔符）
const SEPARATORS = [" | ", " // ", " / ", "\t"];
function splitMainSub(text) {
  const t = String(text || "");
  for (const sep of SEPARATORS) {
    const i = t.indexOf(sep);
    if (i > 0) return [t.slice(0, i), t.slice(i + sep.length)];
  }
  return [t, ""];
}

/** 预处理歌词行：拆出主/副，供模板渲染主行 + 当前行翻译副行。
 *  showTranslation 关闭时丢弃翻译/副歌词，仅显示主歌词。 */
const rows = computed(() =>
  props.lines.map((l) => {
    const [main, sub] = splitMainSub(l.text);
    return { t: l.t, main, sub: config.showTranslation ? sub : "" };
  })
);

const activeIndex = computed(() => {
  if (!rows.value.length) return -1;
  // 应用歌词偏移（毫秒 → 秒）：正=歌词提前，负=歌词延后
  const t = props.currentTime + (props.offset || 0) / 1000;
  let idx = -1;
  for (let i = 0; i < rows.value.length; i++) {
    if (t >= rows.value[i].t) idx = i;
    else break;
  }
  return idx;
});

const offset = computed(() => {
  const safe = Math.max(0, activeIndex.value);
  return viewportHeight.value / 2 - (safe * LINE_HEIGHT + LINE_HEIGHT / 2);
});

watch(
  () => props.lines,
  (lines) => {
    if (lines?.length) requestAnimationFrame(() => (viewportHeight.value = viewport.value?.clientHeight ?? 0));
  },
  { deep: true }
);

onMounted(() => {
  viewportHeight.value = viewport.value?.clientHeight ?? 0;
});
</script>

<style scoped>
.lyrics-panel {
  position: relative;
  height: 180px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--teyvat-bg-dark) 18%, transparent);
  overflow: hidden;
}
.lyrics-panel__viewport {
  height: 100%;
  overflow: hidden;
}
.lyrics-panel__track {
  will-change: transform;
  transition: transform var(--t-base);
}
.lyrics-line-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 var(--space-3);
  gap: 1px;
}
.lyrics-line {
  margin: 0;
  font-size: 13px;
  color: var(--teyvat-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  max-width: 100%;
  transition: color var(--t-base), transform var(--t-base);
}
.lyrics-line-wrap--active .lyrics-line {
  color: var(--teyvat-gold);
  transform: scale(1.05);
  font-weight: var(--font-weight-semibold);
}
.lyrics-sub {
  margin: 0;
  font-size: 11px;
  color: var(--teyvat-text-secondary);
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  max-width: 100%;
}
.lyrics-panel__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--teyvat-text-secondary);
  font-size: 13px;
}
</style>