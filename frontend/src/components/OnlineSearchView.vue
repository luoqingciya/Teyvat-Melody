<template>
  <GlassCard class="online-view">
    <div class="online-view__toolbar">
      <div class="online-view__search">
        <input
          v-model="keyword"
          class="online-view__input ui-input"
          type="text"
          :placeholder="t('online.placeholder')"
          @keyup.enter="doSearch"
        />
        <button v-if="keyword" class="online-view__clear" :title="t('song.clearSearch')" @click="keyword = ''">
          <AppIcon name="x" :size="13" />
        </button>
      </div>
      <button
        class="ui-btn online-view__go"
        :disabled="loading || !keyword.trim() || !available.length"
        @click="doSearch"
      >
        {{ loading ? t("online.searching") : t("online.search") }}
      </button>

      <!-- 平台筛选：只有"有启用源支持"的平台可勾选（否则搜到也播不了） -->
      <div class="online-view__plats">
        <button
          v-for="p in PLATFORMS"
          :key="p.key"
          class="plat-chip"
          :class="{
            'plat-chip--on': picked.includes(p.key),
            'plat-chip--off': !available.includes(p.key),
            'plat-chip--warn': !!warnings[p.key],
          }"
          :disabled="!available.includes(p.key)"
          :title="platTitle(p.key)"
          @click="togglePlat(p.key)"
        >
          <span v-if="warnings[p.key]" class="plat-chip__warn" aria-hidden="true">⚠</span>
          {{ p.label }}
        </button>
      </div>
    </div>

    <div class="online-view__head row-grid">
      <span>#</span>
      <span>{{ t("online.colSong") }}</span>
      <span>{{ t("online.colArtist") }}</span>
      <span>{{ t("online.colAlbum") }}</span>
      <span>{{ t("online.colSource") }}</span>
      <span class="col-duration">{{ t("online.colDuration") }}</span>
      <span></span>
    </div>

    <div class="online-view__scroll">
      <div
        v-for="(song, i) in results"
        :key="song.id"
        class="online-row row-grid"
        :class="{ 'online-row--active': player.currentSong?.id === song.id }"
        @click="playAt(i)"
        @contextmenu.prevent="openMenu($event, song)"
      >
        <span class="col-idx">{{ i + 1 }}</span>
        <span class="col-title" :title="song.title">
          {{ song.title }}
          <span v-if="online.isDownloaded(song)" class="tag-done">{{ t("online.downloadedBadge") }}</span>
        </span>
        <span :title="song.artist || t('online.unknownArtist')">
          {{ song.artist || t("online.unknownArtist") }}
        </span>
        <span :title="song.album || '—'">{{ song.album || "—" }}</span>
        <span class="col-source">
          <span class="src-badge" :title="platTitle(song.source)">{{ platLabel(song.source) }}</span>
        </span>
        <span class="col-duration">{{ formatDuration(song.duration) }}</span>
        <span class="col-ops">
          <button class="op-btn" :title="t('online.play')" :aria-label="t('online.play')" @click.stop="playAt(i)">
            <AppIcon name="play" :size="13" />
          </button>
          <button
            class="op-btn"
            :title="t('online.playNext')"
            :aria-label="t('online.playNext')"
            @click.stop="playNext(song)"
          >
            <AppIcon name="list-music" :size="13" />
          </button>
          <button
            class="op-btn"
            :title="t('online.addQueue')"
            :aria-label="t('online.addQueue')"
            @click.stop="addQueue(song)"
          >
            <AppIcon name="add-to" :size="13" />
          </button>
          <button
            class="op-btn"
            :title="t('ctx.favorite')"
            :aria-label="t('ctx.favorite')"
            @click.stop="online.toggleFavorite(song)"
          >
            <AppIcon name="heart-outline" :size="13" />
          </button>
          <button
            class="op-btn"
            :class="{ 'op-btn--on': online.isDownloaded(song) }"
            :title="online.isDownloaded(song) ? t('online.downloaded') : t('online.download')"
            :aria-label="t('online.download')"
            :disabled="online.isDownloaded(song)"
            @click.stop="downloadSong(song)"
          >
            <AppIcon name="download" :size="13" />
          </button>
        </span>
      </div>
    </div>

    <div v-if="!results.length" class="online-view__empty">{{ emptyText }}</div>

    <SongContextMenu
      :visible="ctx.visible"
      :x="ctx.x"
      :y="ctx.y"
      :song="ctx.song"
      :playing="player.currentSong?.id === ctx.song?.id"
      :fav="!!ctx.song?.favorite"
      :qualities="ctx.song ? online.qualitiesFor(ctx.song.source) : []"
      :quality="ctx.song?.quality || ''"
      :downloaded="ctx.song ? online.isDownloaded(ctx.song) : false"
      :download-percent="ctxPercent"
      online
      @close="ctx.visible = false"
      @play="playCtx"
      @play-next="playNextCtx"
      @add-queue="addQueueCtx"
      @toggle-fav="favCtx"
      @add-playlist="addPlaylistCtx"
      @set-quality="setQualityCtx"
      @download="downloadCtx"
    />

    <PlaylistPickerModal
      :visible="picker.visible"
      :song="picker.song"
      @close="picker.visible = false"
    />
  </GlassCard>
</template>

<script setup>
import { ref, computed, onMounted, watch } from "vue";
import GlassCard from "./GlassCard.vue";
import SongContextMenu from "./SongContextMenu.vue";
import PlaylistPickerModal from "./PlaylistPickerModal.vue";
import AppIcon from "./AppIcon.vue";
import { usePlayerStore } from "@/stores/player";
import { useOnlineLibrary } from "@/composables/useOnlineLibrary";
import { useI18n } from "@/utils/i18n";
import { toast, toastError } from "@/utils/toast";
import { toPlain } from "@/utils/bridge";

const PLATFORMS = [
  { key: "kw", label: "酷我" },
  { key: "kg", label: "酷狗" },
  { key: "tx", label: "QQ音乐" },
  { key: "wy", label: "网易云" },
];

const player = usePlayerStore();
const online = useOnlineLibrary();
const { t } = useI18n();

const keyword = ref("");
const loading = ref(false);
const results = ref([]);
const searched = ref(false);
const errorMsg = ref("");
const available = ref([]); // 有启用源支持的平台
const qualitys = ref({}); // 各平台源声明支持的音质
// 各平台最近的解析失败记录（源声明支持、实际却解析不出地址）：提前提示，避免「搜得到却播不了」
const warnings = ref({});
const picked = ref([]); // 当前勾选的平台
let searchToken = 0; // 并发令牌：连续搜索时丢弃旧结果

const emptyText = computed(() => {
  if (loading.value) return t("online.searching");
  if (!available.value.length) return t("online.noSource");
  if (errorMsg.value) return errorMsg.value;
  if (!searched.value) return t("online.hint");
  return t("online.noResult");
});

function platLabel(key) {
  return PLATFORMS.find((p) => p.key === key)?.label || key;
}

/** 平台 chip / 来源徽标的提示：可用平台展示其源声明支持的最高音质；解析失败过的平台给出原因 */
function platTitle(key) {
  if (!available.value.includes(key)) return t("online.noSource");
  const warn = warnings.value[key];
  if (warn) return `${platLabel(key)} · ${t("online.platformWarnTitle")}：${warn.message}`;
  const q = qualitys.value[key] || [];
  return q.length ? `${platLabel(key)} · ${q.join(" / ")}` : platLabel(key);
}

async function loadPlatforms() {
  const api = window.pywebview?.api;
  if (!api || typeof api.getOnlinePlatforms !== "function") return;
  try {
    const r = await api.getOnlinePlatforms();
    available.value = r?.platforms ?? [];
    qualitys.value = r?.qualitys ?? {};
    warnings.value = r?.warnings ?? {};
  } catch {
    available.value = [];
    qualitys.value = {};
    warnings.value = {};
  }
  // 默认勾选全部可用平台
  picked.value = [...available.value];
}

/** 只刷新失败提示，不动用户已勾选的平台（播放失败后调用） */
async function refreshWarnings() {
  const api = window.pywebview?.api;
  if (!api || typeof api.getOnlinePlatforms !== "function") return;
  try {
    const r = await api.getOnlinePlatforms();
    warnings.value = r?.warnings ?? {};
  } catch {
    /* 刷新失败保持原样即可 */
  }
}

function togglePlat(key) {
  if (!available.value.includes(key)) return;
  const i = picked.value.indexOf(key);
  if (i >= 0) picked.value.splice(i, 1);
  else picked.value.push(key);
}

async function doSearch() {
  const kw = keyword.value.trim();
  if (!kw || loading.value) return;
  if (!available.value.length) {
    toastError(t("online.noSource"));
    return;
  }
  const token = ++searchToken;
  loading.value = true;
  errorMsg.value = "";
  try {
    const api = window.pywebview?.api;
    if (!api || typeof api.searchOnline !== "function") throw new Error("当前环境不支持在线搜索");
    // picked 是 reactive 数组：跨 contextBridge 前必须转成普通值，否则结构化克隆会拒绝
    const r = await api.searchOnline(kw, toPlain(picked.value));
    if (token !== searchToken) return; // 已被后续搜索取代
    searched.value = true;
    if (!r || !r.ok) {
      results.value = [];
      errorMsg.value = r?.message || t("online.failed", { m: "unknown" });
      return;
    }
    results.value = r.list ?? [];
    // 单平台失败不阻断其它平台：结果照常展示，失败信息以 toast 提示
    if (r.errors?.length) toast(t("online.partialFailed", { m: r.errors.join("；") }));
  } catch (e) {
    if (token !== searchToken) return;
    results.value = [];
    searched.value = true;
    errorMsg.value = t("online.failed", { m: e.message });
  } finally {
    if (token === searchToken) loading.value = false;
  }
}

function playAt(index) {
  if (!results.value.length || index < 0) return;
  // 以当前结果列表为播放队列，便于 next / prev
  player.playQueue(results.value, index);
}

function playNext(song) {
  if (song) player.playNext(song);
}

function addQueue(song) {
  if (song) player.addToQueue(song);
}

/** 下载到本地曲库：按当前选中的音质（未选则由降级链挑最高可用） */
function downloadSong(song, quality) {
  if (!song) return;
  online.download(song, quality ?? song.quality ?? "");
}

// ---- 右键菜单 ----
const ctx = ref({ visible: false, x: 0, y: 0, song: null });
const picker = ref({ visible: false, song: null });

const ctxPercent = computed(() => {
  const p = ctx.value.song ? online.progressOf(ctx.value.song) : null;
  return p && !p.done && p.percent != null ? p.percent : null;
});

function openMenu(e, song) {
  ctx.value = { visible: true, x: e.clientX, y: e.clientY, song };
}

function playCtx() {
  const s = ctx.value.song;
  ctx.value.visible = false;
  if (!s) return;
  const i = results.value.findIndex((x) => x.id === s.id);
  playAt(i >= 0 ? i : 0);
}

function playNextCtx() {
  if (ctx.value.song) player.playNext(ctx.value.song);
  ctx.value.visible = false;
}

function addQueueCtx() {
  if (ctx.value.song) player.addToQueue(ctx.value.song);
  ctx.value.visible = false;
}

async function favCtx() {
  const s = ctx.value.song;
  ctx.value.visible = false;
  if (s) await online.toggleFavorite(s);
}

function addPlaylistCtx() {
  picker.value = { visible: true, song: ctx.value.song };
  ctx.value.visible = false;
}

async function setQualityCtx(q) {
  const s = ctx.value.song;
  ctx.value.visible = false;
  if (s) await online.setQuality(s, q);
}

function downloadCtx() {
  const s = ctx.value.song;
  ctx.value.visible = false;
  if (s) downloadSong(s, s.quality);
}

function formatDuration(sec) {
  if (!sec) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

onMounted(async () => {
  await Promise.all([loadPlatforms(), online.loadMeta(true), online.loadDownloaded()]);
});

// 播放失败后刷新失败提示：让「这个平台你的源播不了」立刻反映到筛选条上，
// 而不是等用户再搜一次才发现。
watch(
  () => player.lastOnlineError,
  (err) => {
    if (err) refreshWarnings();
  }
);
</script>

<style scoped>
.online-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.online-view :deep(.glass-card__body) {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  flex: 1;
  min-height: 0;
}

.online-view__toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--teyvat-card-border);
  flex-wrap: wrap;
}
.online-view__search {
  position: relative;
  display: inline-flex;
}
.online-view__input {
  width: 260px;
  padding: 6px 28px 6px var(--space-3);
}
.online-view__clear {
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
.online-view__clear:hover {
  color: var(--teyvat-text-primary);
}
.online-view__go {
  flex-shrink: 0;
}
.online-view__plats {
  display: flex;
  gap: var(--space-1);
  margin-left: auto;
}
.plat-chip {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--teyvat-card-border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.plat-chip:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: var(--teyvat-text-primary);
}
.plat-chip--on {
  background: color-mix(in srgb, var(--teyvat-gold) 18%, transparent);
  border-color: color-mix(in srgb, var(--teyvat-gold) 45%, transparent);
  color: var(--teyvat-gold);
}
.plat-chip--off {
  opacity: 0.4;
  cursor: not-allowed;
}
/* 该平台最近解析失败过（源声明支持、实际播不了）：加个警示，避免用户反复踩同一个坑 */
.plat-chip--warn {
  border-color: color-mix(in srgb, var(--teyvat-danger) 55%, transparent);
  color: var(--teyvat-danger);
}
.plat-chip__warn {
  margin-right: 4px;
  font-size: 11px;
}

.row-grid {
  display: grid;
  grid-template-columns: 36px 1.5fr 1fr 1fr 72px 56px 148px;
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

.online-view__head {
  color: var(--teyvat-text-secondary);
  font-size: 12px;
  padding-top: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--teyvat-card-border);
}

.online-view__scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.online-row {
  height: 52px;
  font-size: 13px;
  color: var(--teyvat-text-primary);
  border-bottom: 1px solid color-mix(in srgb, var(--teyvat-text-secondary) 8%, transparent);
  cursor: pointer;
  transition: background var(--t-fast);
}
.online-row:hover {
  background: color-mix(in srgb, var(--teyvat-text-primary) 5%, transparent);
}
.online-row--active {
  background: var(--playlist-active-row);
}
.online-row--active .col-title {
  color: var(--teyvat-gold);
}
.col-idx {
  color: var(--teyvat-text-secondary);
}
.col-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.col-duration {
  text-align: right;
  color: var(--teyvat-text-secondary);
}
.col-source {
  overflow: visible;
}
.src-badge {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--teyvat-blue) 22%, transparent);
  color: var(--teyvat-text-primary);
  border: 1px solid color-mix(in srgb, var(--teyvat-blue) 40%, transparent);
}
/* 「已下载」标记：避免用户对同一首反复点下载 */
.tag-done {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 10px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--teyvat-gold) 18%, transparent);
  color: var(--teyvat-gold);
  border: 1px solid color-mix(in srgb, var(--teyvat-gold) 40%, transparent);
}
.col-ops {
  display: flex;
  gap: 2px;
  justify-content: flex-end;
  opacity: 0;
  transition: opacity var(--t-fast);
  overflow: visible;
}
.online-row:hover .col-ops,
.online-row--active .col-ops {
  opacity: 1;
}
.op-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast);
}
.op-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--teyvat-gold) 16%, transparent);
  color: var(--teyvat-gold);
}
.op-btn:disabled {
  cursor: default;
}
.op-btn--on {
  color: var(--teyvat-gold);
  opacity: 0.7;
}
.online-view__empty {
  text-align: center;
  color: var(--teyvat-text-secondary);
  padding: var(--space-8);
  font-size: 13px;
}
</style>
