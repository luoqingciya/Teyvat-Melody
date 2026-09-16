<template>
  <div class="lyrics-panel">
    <div ref="viewport" class="lyrics-panel__viewport">
      <div
        class="lyrics-panel__track"
        :style="{ transform: `translateY(${scrollOffset}px)` }"
      >
        <div
          v-for="(row, i) in rows"
          :key="i"
          class="lyrics-line-wrap"
          :class="{ 'lyrics-line-wrap--active': i === activeIndex }"
          :style="{ height: rowHeight + 'px' }"
        >
          <p class="lyrics-line">
            <template v-if="i === activeIndex && activeWordSpans.length">
              <span
                v-for="(w, wi) in activeWordSpans"
                :key="wi"
                :class="{
                  'ly-word--done': w.frac >= 1,
                  'ly-word--pending': w.frac <= 0,
                  'ly-word--partial': w.frac > 0 && w.frac < 1,
                }"
                :style="w.frac > 0 && w.frac < 1 ? { '--p': w.frac * 100 + '%' } : null"
              >{{ w.text }}</span>
            </template>
            <template v-else>{{ row.main }}</template>
          </p>
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
import { buildWordSpans } from "@/utils/karaokeWords";

const props = defineProps({
  lines: { type: Array, default: () => [] },
  currentTime: { type: Number, default: 0 },
  // 歌词偏移（毫秒），与桌面歌词/播放器 store 的 lyricOffset 保持一致
  offset: { type: Number, default: 0 },
  /**
   * 每行高度（px）。**必须随字号一起变大**：
   * 行容器是定高的，字号调大后内容比容器还高就会被裁掉
   *（实测全屏字号 32 时内容 93px，而行高固定 46px → 上下各切掉一截）。
   * 调用方（全屏播放页）按自己的字号算好传进来；主界面字号固定，用默认值即可。
   */
  lineHeight: { type: Number, default: 46 },
});

const config = useConfigStore();
const { t } = useI18n();

// 每行歌词高度（px，含可能的翻译副行）。默认值对应主界面的固定字号。
const rowHeight = computed(() => Math.max(24, Number(props.lineHeight) || 46));
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
    // words 原样带着：只有当前行会用到，供逐字高亮
    return { t: l.t, main, sub: config.showTranslation ? sub : "", words: l.words || null };
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

/**
 * 当前行的逐字分段（仅在开启逐字且该行确有 words 时非空）。
 *
 * 语义与桌面歌词（electron/lyrics.html 的 wordsKaraokeHtml）保持一致：
 * 逐字时间轴来自 KRC / lxlyric 解析（`{t, d, text}`），字内再按**该字自身时长**
 * 做渐变，高亮连续推进而不是整字跳变。没有 words 的歌词源会走原来的整行高亮。
 */
const activeWordSpans = computed(() => {
  if (!config.karaokeInPanel) return [];
  const row = rows.value[activeIndex.value];
  if (!row || !row.words || !row.words.length) return [];
  return buildWordSpans(row.words, props.currentTime + (props.offset || 0) / 1000);
});

const scrollOffset = computed(() => {
  const safe = Math.max(0, activeIndex.value);
  return viewportHeight.value / 2 - (safe * rowHeight.value + rowHeight.value / 2);
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
  /* flex: none —— 容器是定高的，内容一旦略微超出，flex 会先把这两行压扁，
     结果就是「翻译行突然变矮、文字被切」。宁可让它溢出（外层本来就裁不到），也不压缩。 */
  flex: none;
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
/* 逐字高亮：已唱完=金色、未唱=次要色、正在唱=字内渐变（左金右灰，随进度推进）。
   与桌面歌词同一套语义（见 electron/lyrics.html）。 */
.ly-word--done {
  color: var(--teyvat-gold);
}
.ly-word--pending {
  color: var(--teyvat-text-secondary);
}
.ly-word--partial {
  background: linear-gradient(
    90deg,
    var(--teyvat-gold) var(--p, 0%),
    var(--teyvat-text-secondary) var(--p, 0%)
  );
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.lyrics-sub {
  margin: 0;
  font-size: 11px;
  flex: none;
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
