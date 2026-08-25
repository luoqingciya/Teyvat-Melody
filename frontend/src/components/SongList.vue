<template>
  <GlassCard class="song-table">
    <div class="song-table__toolbar">
      <div class="song-search-wrap">
        <input
          v-model="keyword"
          class="song-search ui-input"
          type="text"
          :placeholder="t('song.searchPlaceholder')"
        />
        <button v-if="keyword" class="song-search__clear" :title="t('song.clearSearch')" @click="keyword = ''">
          <AppIcon name="x" :size="13" />
        </button>
      </div>
    </div>

    <div class="song-table__head row-grid">
      <span class="col-fav"></span>
      <span class="col-idx">#</span>
      <span>{{ t("song.colSong") }}</span>
      <span>{{ t("song.colArtist") }}</span>
      <span>{{ t("song.colAlbum") }}</span>
      <span class="col-quality">{{ t("song.colQuality") }}</span>
      <span class="col-duration">{{ t("song.colDuration") }}</span>
    </div>

    <div ref="scrollEl" class="song-scroll" @scroll="onScroll">
      <div class="song-spacer" :style="{ height: totalHeight + 'px' }">
        <div
          v-for="(song, v) in visibleSongs"
          :key="song.id"
          class="song-row row-grid"
          :style="{ transform: `translateY(${(startIndex + v) * ROW_HEIGHT}px)` }"
          :class="{ 'song-row--active': player.currentSong?.id === song.id }"
          @click="playAt(startIndex + v)"
          @contextmenu.prevent="openContextMenu($event, song)"
        >
          <button
            class="col-fav fav-btn"
            :class="{ 'fav-btn--on': song.favorite }"
            :title="t('song.fav')"
            :aria-label="t('song.fav')"
            :aria-pressed="song.favorite"
            @click.stop="toggleFav(song)"
          >
            <AppIcon :name="song.favorite ? 'heart' : 'heart-outline'" :size="15" />
          </button>
          <span class="col-idx">{{ startIndex + v + 1 }}</span>
          <span class="col-title" :title="song.title">
            <span class="col-title__text">
              {{ song.title }}
            </span>
          </span>
          <span :title="song.artist || t('song.unknownArtist')">{{ song.artist || t("song.unknownArtist") }}</span>
          <span :title="song.album || '—'">{{ song.album || "—" }}</span>
          <span class="col-quality" :title="qualityLabel(song)">{{ qualityLabel(song) }}</span>
          <span class="col-duration">{{ formatDuration(song.duration) }}</span>
        </div>
      </div>
    </div>

    <div v-if="!total" class="song-table__empty">{{ emptyMessage }}</div>

    <SongContextMenu
      :visible="ctx.visible"
      :x="ctx.x"
      :y="ctx.y"
      :song="ctx.song"
      :playing="player.currentSong?.id === ctx.song?.id"
      :fav="!!ctx.song?.favorite"
      @close="ctx.visible = false"
      @play="playCtx"
      @play-next="playNextCtx"
      @add-queue="addQueueCtx"
      @toggle-fav="toggleFavCtx"
      @detail="openDetail"
      @edit="openEdit"
    />
    <SongDetailModal
      :visible="detailVisible"
      :song="detailSong"
      @close="detailVisible = false"
      @play="playDetail"
      @toggle-fav="toggleFavDetail"
    />
    <SongEditModal
      :visible="editVisible"
      :song="editSong"
      @close="editVisible = false"
      @saved="onEditSaved"
    />
  </GlassCard>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useRoute } from "vue-router";
import GlassCard from "./GlassCard.vue";
import SongContextMenu from "./SongContextMenu.vue";
import SongDetailModal from "./SongDetailModal.vue";
import SongEditModal from "./SongEditModal.vue";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistStore } from "@/stores/playlist";
import { usePlayerStore } from "@/stores/player";
import { useConfigStore } from "@/stores/config";
import { useI18n } from "@/utils/i18n";

const ROW_HEIGHT = 52; // 行高（px），与 CSS 保持一致
const OVERSCAN = 6; // 上下额外渲染行数

const route = useRoute();
const library = useLibraryStore();
const playlist = usePlaylistStore();
const player = usePlayerStore();
const config = useConfigStore();
const { t } = useI18n();

const keyword = ref("");
const scrollEl = ref(null);
const scrollTop = ref(0);
const viewHeight = ref(0);

// 最近播放：按 config.recentSongs 中的 id 顺序从曲库中反查
const recentSongs = computed(() => {
  const map = new Map(library.songList.map((s) => [s.id, s]));
  return config.recentSongs.map((id) => map.get(id)).filter(Boolean);
});

// 按路由选取数据源
const baseSongs = computed(() => {
  if (route.name === "favorites") return library.favorites;
  if (route.name === "recent") return recentSongs.value;
  if (route.name === "playlist") return playlist.currentSongs;
  return library.songList;
});

// 搜索过滤
const songs = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return baseSongs.value;
  return baseSongs.value.filter((s) =>
    [s.title, s.artist, s.album].some((f) => String(f ?? "").toLowerCase().includes(kw))
  );
});

// 空状态文案：按路由显示对应提示，避免"我的收藏/最近音乐"误导用户去扫描音乐库
const emptyMessage = computed(() => {
  if (route.name === "favorites") return t("song.emptyFav");
  if (route.name === "recent") return t("song.emptyRecent");
  if (route.name === "playlist") return t("song.emptyPlaylist");
  return t("song.emptyAll");
});

const total = computed(() => songs.value.length);
const totalHeight = computed(() => Math.max(total.value, 0) * ROW_HEIGHT);

const startIndex = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT))
);
const visibleCount = computed(() =>
  Math.ceil(viewHeight.value / ROW_HEIGHT) + OVERSCAN * 2
);
const endIndex = computed(() => Math.min(total.value, startIndex.value + visibleCount.value));
const visibleSongs = computed(() => songs.value.slice(startIndex.value, endIndex.value));

let rafId = 0;
function onScroll() {
  if (rafId) return;
  // rAF 节流：滚动事件高频触发，仅在下一帧读取一次 scrollTop，避免每帧同步重算
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    scrollTop.value = scrollEl.value?.scrollTop ?? 0;
  });
}

function measure() {
  viewHeight.value = scrollEl.value?.clientHeight ?? 0;
}

function playAt(index) {
  player.playQueue(songs.value, index);
}

function toggleFav(song) {
  library.toggleFavorite(song);
}

// ---- 歌曲右键菜单 ----
const ctx = ref({ visible: false, x: 0, y: 0, song: null });
const detailVisible = ref(false);
const detailSong = ref(null);
const editVisible = ref(false);
const editSong = ref(null);

function openContextMenu(e, song) {
  ctx.value = { visible: true, x: e.clientX, y: e.clientY, song };
}

function playAtFully(song) {
  const idx = songs.value.findIndex((s) => s.id === song.id);
  player.playQueue(songs.value, idx >= 0 ? idx : 0);
}

function playCtx() {
  if (ctx.value.song) playAtFully(ctx.value.song);
  ctx.value.visible = false;
}

function playNextCtx() {
  if (ctx.value.song) player.playNext(ctx.value.song);
  ctx.value.visible = false;
}

function addQueueCtx() {
  if (ctx.value.song) player.addToQueue(ctx.value.song);
  ctx.value.visible = false;
}

async function toggleFavCtx() {
  if (ctx.value.song) await library.toggleFavorite(ctx.value.song);
  ctx.value.visible = false;
}

function openDetail() {
  detailSong.value = ctx.value.song;
  detailVisible.value = true;
  ctx.value.visible = false;
}

function openEdit() {
  editSong.value = ctx.value.song;
  editVisible.value = true;
  ctx.value.visible = false;
}

async function onEditSaved() {
  editVisible.value = false;
  await library.load();
  const s = editSong.value;
  if (s && player.currentSong?.id === s.id) {
    const fresh = library.songList.find((x) => x.id === s.id);
    if (fresh) Object.assign(s, fresh);
  }
}

async function toggleFavDetail() {
  if (detailSong.value) await library.toggleFavorite(detailSong.value);
}

function playDetail() {
  if (detailSong.value) playAtFully(detailSong.value);
  detailVisible.value = false;
}

function formatDuration(sec) {
  if (!sec) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function qualityLabel(song) {
  const parts = [];
  if (song.format) parts.push(String(song.format).toUpperCase());
  if (song.bitrate) parts.push(`${Math.round(song.bitrate)}k`);
  if (song.sample_rate) parts.push(`${(song.sample_rate / 1000).toFixed(1)}kHz`);
  return parts.join(" · ") || "—";
}

// 歌单路由：进入时加载该歌单歌曲
watch(
  () => route.params.id,
  async (id) => {
    if (route.name === "playlist" && id) {
      scrollTop.value = 0;
      await playlist.loadSongs(id);
    }
  },
  { immediate: true }
);

onMounted(() => {
  // 歌单数据加载由上方 watch(immediate) 统一处理，避免进入 /playlist/:id 时重复请求
  nextTick(measure);
  window.addEventListener("resize", measure);
});

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
  window.removeEventListener("resize", measure);
});
</script>

<style scoped>
.song-table {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.song-table :deep(.glass-card__body) {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  flex: 1;
  min-height: 0;
}

.song-search-wrap {
  position: relative;
  display: inline-flex;
}
.song-search {
  width: 240px;
  padding: 6px 28px 6px var(--space-3);
}
.song-search__clear {
  position: absolute;
  right: var(--space-2);
  top: 50%;
  transform: translateY(-50%);
  border: none;
  background: transparent;
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  transition: color var(--t-fast);
}
.song-search__clear:hover {
  color: var(--teyvat-text-primary);
}
.song-table__toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--teyvat-card-border);
}

.row-grid {
  display: grid;
  grid-template-columns: 34px 36px 1.4fr 1fr 1fr minmax(104px, auto) 56px;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-4);
}
.row-grid > * {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-table__head {
  color: var(--teyvat-text-secondary);
  font-size: 12px;
  padding-top: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--teyvat-card-border);
}

.song-scroll {
  flex: 1;
  overflow-y: auto;
  position: relative;
  min-height: 0;
}
.song-spacer {
  position: relative;
  width: 100%;
}
.song-row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 52px;
  font-size: 13px;
  color: var(--teyvat-text-primary);
  border-bottom: 1px solid color-mix(in srgb, var(--teyvat-text-secondary) 8%, transparent);
  cursor: pointer;
  will-change: transform;
  transition: background var(--t-fast);
}
.song-row:hover {
  background: color-mix(in srgb, var(--teyvat-text-primary) 5%, transparent);
}
.song-row--active {
  background: var(--playlist-active-row);
}
.song-row--active .col-title {
  color: var(--teyvat-gold);
}
.col-idx {
  color: var(--teyvat-text-secondary);
}
.col-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.col-title__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.col-duration {
  text-align: right;
  color: var(--teyvat-text-secondary);
}
.col-quality {
  color: var(--teyvat-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.fav-btn {
  border: none;
  background: none;
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  opacity: 0.5;
  transition: opacity var(--t-fast), color var(--t-fast), transform var(--t-fast);
  padding: 2px;
  display: inline-flex;
  align-items: center;
}
.song-row:hover .fav-btn {
  opacity: 0.9;
}
.fav-btn--on {
  opacity: 1;
  color: var(--teyvat-danger);
}
.fav-btn:active {
  transform: scale(0.9);
}
.song-table__empty {
  text-align: center;
  color: var(--teyvat-text-secondary);
  padding: var(--space-8);
  font-size: 13px;
}
</style>
