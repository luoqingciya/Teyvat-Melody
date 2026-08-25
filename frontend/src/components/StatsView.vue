<template>
  <GlassCard class="stats">
    <div class="stats__toolbar">
      <span class="stats__title ui-heading">播放统计</span>
      <div class="stats__range">
        <button
          v-for="r in ranges"
          :key="r"
          class="stats__range-btn ui-btn ui-btn--ghost"
          :class="{ 'stats__range-btn--active': days === r }"
          @click="days = r"
        >
          {{ r }} 天
        </button>
      </div>
    </div>

    <div v-if="loading" class="stats__loading">加载中…</div>

    <template v-else-if="stats">
      <div class="stats__cards">
        <div class="stats__card">
          <span class="stats__card-label">总播放次数</span>
          <span class="stats__card-value">{{ stats.total_plays }}</span>
        </div>
        <div class="stats__card">
          <span class="stats__card-label">播放过歌曲</span>
          <span class="stats__card-value">{{ stats.unique_songs }}</span>
        </div>
        <div class="stats__card">
          <span class="stats__card-label">累计时长</span>
          <span class="stats__card-value">{{ formatDuration(stats.play_duration) }}</span>
        </div>
      </div>

      <div class="stats__section">
        <h4 class="stats__section-title">每日播放</h4>
        <div class="stats__bars stats__bars--daily">
          <div
            v-for="d in stats.daily"
            :key="d.day"
            class="stats__bar-col"
            :title="`${d.day}：${d.plays} 次`"
          >
            <span class="stats__bar-value">{{ d.plays }}</span>
            <div class="stats__bar" :style="{ height: barHeight(d.plays, maxDaily) }"></div>
            <span class="stats__bar-label">{{ d.day.slice(5) }}</span>
          </div>
          <div v-if="!stats.daily.length" class="stats__empty">暂无播放记录</div>
        </div>
      </div>

      <div class="stats__section">
        <h4 class="stats__section-title">月度播放</h4>
        <div class="stats__bars stats__bars--monthly">
          <div
            v-for="m in stats.monthly"
            :key="m.month"
            class="stats__bar-col"
            :title="`${m.month}：${m.plays} 次`"
          >
            <span class="stats__bar-value">{{ m.plays }}</span>
            <div class="stats__bar" :style="{ height: barHeight(m.plays, maxMonthly) }"></div>
            <span class="stats__bar-label">{{ m.month }}</span>
          </div>
          <div v-if="!stats.monthly.length" class="stats__empty">暂无播放记录</div>
        </div>
      </div>

      <div class="stats__section">
        <h4 class="stats__section-title">热门歌曲 TOP10</h4>
        <div class="stats__top">
          <div v-for="(s, i) in stats.top_songs" :key="s.id" class="stats__top-row">
            <span class="stats__top-idx">{{ i + 1 }}</span>
            <span class="stats__top-title" :title="s.title">{{ s.title }}</span>
            <span class="stats__top-artist">{{ s.artist || "未知" }}</span>
            <span class="stats__top-plays">{{ s.plays }} 次</span>
          </div>
          <div v-if="!stats.top_songs.length" class="stats__empty">暂无播放记录</div>
        </div>
      </div>
    </template>
  </GlassCard>
</template>

<script setup>
import { ref, computed, watch, onMounted } from "vue";
import GlassCard from "./GlassCard.vue";
import { useApi } from "@/composables/useApi";

const { getPlaybackStats } = useApi();
const days = ref(30);
const ranges = [7, 30, 90, 365];
const stats = ref(null);
const loading = ref(false);

const maxDaily = computed(() => Math.max(1, ...(stats.value?.daily || []).map((d) => d.plays)));
const maxMonthly = computed(() => Math.max(1, ...(stats.value?.monthly || []).map((m) => m.plays)));

function barHeight(v, max) {
  return `${Math.max(6, (v / max) * 100)}%`;
}

function formatDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return "0h 0m";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  const mm = Math.floor(sec / 60);
  const ss = Math.floor(sec % 60);
  return `${mm}m ${ss}s`;
}

async function load() {
  loading.value = true;
  try {
    const res = await getPlaybackStats(days.value);
    stats.value = res?.data ?? null;
  } catch (_) {
    stats.value = null;
  } finally {
    loading.value = false;
  }
}

watch(days, load);
onMounted(load);
</script>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.stats__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  row-gap: var(--space-2);
  column-gap: var(--space-3);
  padding-bottom: var(--space-1);
}
.stats__title {
  color: var(--teyvat-text-primary);
}
.stats__range {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: flex-end;
}
.stats__range-btn--active {
  background: color-mix(in srgb, var(--teyvat-gold) 20%, transparent);
  color: var(--teyvat-gold);
}
.stats__loading,
.stats__empty {
  text-align: center;
  color: var(--teyvat-text-secondary);
  padding: var(--space-6);
  font-size: 13px;
}
.stats__cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}
.stats__card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--teyvat-text-primary) 5%, transparent);
  border: 1px solid var(--teyvat-card-border);
}
.stats__card-label {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.stats__card-value {
  font-size: 26px;
  font-weight: var(--font-weight-bold);
  color: var(--teyvat-gold);
}
.stats__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.stats__section-title {
  font-size: 14px;
  color: var(--teyvat-text-primary);
  margin: 0;
}
.stats__bars {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  min-height: 120px;
  padding: var(--space-2) var(--space-1) 0;
  border: 1px solid var(--teyvat-card-border);
  border-radius: var(--radius-lg);
  overflow-x: auto;
}
.stats__bar-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  flex: 1;
  min-width: 22px;
  gap: var(--space-1);
  height: 120px;
}
.stats__bar-value {
  font-size: 10px;
  color: var(--teyvat-text-secondary);
}
.stats__bar {
  width: 70%;
  max-width: 34px;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--teyvat-gold) 85%, transparent),
    color-mix(in srgb, var(--teyvat-blue) 60%, transparent)
  );
  transition: height var(--t-slow);
}
.stats__bar-label {
  font-size: 10px;
  color: var(--teyvat-text-secondary);
  white-space: nowrap;
}
.stats__top {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.stats__top-row {
  display: grid;
  grid-template-columns: 32px 1.6fr 1fr 64px;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  font-size: 13px;
}
.stats__top-row:nth-child(odd) {
  background: color-mix(in srgb, var(--teyvat-text-primary) 4%, transparent);
}
.stats__top-idx {
  color: var(--teyvat-text-secondary);
}
.stats__top-title {
  color: var(--teyvat-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stats__top-artist {
  color: var(--teyvat-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stats__top-plays {
  text-align: right;
  color: var(--teyvat-gold);
}
</style>
