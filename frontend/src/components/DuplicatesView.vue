<template>
  <GlassCard class="dups">
    <div class="dups__toolbar">
      <span class="dups__title ui-heading">重复歌曲检测</span>
      <button class="dups__refresh ui-btn ui-btn--ghost" :disabled="loading" @click="load">
        <AppIcon name="refresh" :size="14" />
        <span>重新检测</span>
      </button>
    </div>

    <div v-if="loading" class="dups__empty">检测中…</div>

    <template v-else-if="groups.length">
      <p v-if="summary" class="dups__summary">
        共发现 {{ summary.count }} 组疑似重复（共 {{ summary.total }} 首）
      </p>
      <div class="dups__groups">
        <div v-for="(g, gi) in groups" :key="gi" class="dups__group">
          <div class="dups__group-head">
            <span class="dups__group-title">{{ g.title }}</span>
            <span class="dups__group-artist">{{ g.artist || "未知艺术家" }}</span>
            <span class="dups__group-count">{{ g.count }} 首</span>
          </div>
          <div class="dups__songs">
            <div v-for="s in g.songs" :key="s.id" class="dups__song" @click="play(s)">
              <span class="dups__song-idx">{{ s.id }}</span>
              <AlbumArt class="dups__song-cover" :src="s.has_cover ? `/api/songs/${s.id}/cover` : ''" />
              <span class="dups__song-title" :title="s.path">{{ s.title }}</span>
              <span class="dups__song-duration">{{ formatDuration(s.duration) }}</span>
              <span class="dups__song-path" :title="s.path">{{ s.path }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="dups__empty">未发现重复歌曲 🎉</div>
  </GlassCard>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import GlassCard from "./GlassCard.vue";
import AppIcon from "./AppIcon.vue";
import AlbumArt from "./AlbumArt.vue";
import { useApi } from "@/composables/useApi";
import { usePlayerStore } from "@/stores/player";
import { useLibraryStore } from "@/stores/library";

const { getDuplicates } = useApi();
const player = usePlayerStore();
const library = useLibraryStore();
const groups = ref([]);
const loading = ref(false);

const summary = computed(() => {
  if (!groups.value.length) return null;
  const total = groups.value.reduce((acc, g) => acc + g.count, 0);
  return { count: groups.value.length, total };
});

function formatDuration(sec) {
  if (!sec) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function play(song) {
  const idx = library.songList.findIndex((x) => x.id === song.id);
  if (idx >= 0) player.playQueue(library.songList, idx);
}

async function load() {
  loading.value = true;
  try {
    const res = await getDuplicates();
    groups.value = res?.data || [];
  } catch (_) {
    groups.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.dups {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.dups__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.dups__title {
  color: var(--teyvat-text-primary);
}
.dups__refresh:hover {
  background: color-mix(in srgb, var(--teyvat-gold) 15%, transparent);
}
.dups__summary {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
  margin: 0;
}
.dups__groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.dups__group {
  border: 1px solid var(--teyvat-card-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.dups__group-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  background: color-mix(in srgb, var(--teyvat-gold) 8%, transparent);
  border-bottom: 1px solid var(--teyvat-card-border);
}
.dups__group-title {
  font-size: 14px;
  font-weight: var(--font-weight-semibold);
  color: var(--teyvat-gold);
}
.dups__group-artist {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.dups__group-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.dups__songs {
  display: flex;
  flex-direction: column;
}
.dups__song {
  display: grid;
  grid-template-columns: 30px 36px 1.4fr 56px 1fr;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-size: 13px;
  cursor: pointer;
  transition: background var(--t-fast);
}
.dups__song:hover {
  background: color-mix(in srgb, var(--teyvat-text-primary) 5%, transparent);
}
.dups__song-idx {
  color: var(--teyvat-text-secondary);
}
.dups__song-cover {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
}
.dups__song-title {
  color: var(--teyvat-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dups__song-duration {
  text-align: right;
  color: var(--teyvat-text-secondary);
}
.dups__song-path {
  color: var(--teyvat-text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dups__empty {
  text-align: center;
  color: var(--teyvat-text-secondary);
  padding: var(--space-8);
  font-size: 14px;
}
</style>
