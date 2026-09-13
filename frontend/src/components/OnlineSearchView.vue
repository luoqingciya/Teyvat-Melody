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
          :class="{ 'plat-chip--on': picked.includes(p.key), 'plat-chip--off': !available.includes(p.key) }"
          :disabled="!available.includes(p.key)"
          :title="platTitle(p.key)"
          @click="togglePlat(p.key)"
        >
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
        <span class="col-title" :title="song.title">{{ song.title }}</span>
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
      online
      @close="ctx.visible = false"
      @play="playCtx"
      @play-next="playNextCtx"
      @add-queue="addQueueCtx"
    />
  </GlassCard>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import GlassCard from "./GlassCard.vue";
import SongContextMenu from "./SongContextMenu.vue";
import AppIcon from "./AppIcon.vue";
import { usePlayerStore } from "@/stores/player";
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
const { t } = useI18n();

const keyword = ref("");
const loading = ref(false);
const results = ref([]);
const searched = ref(false);
const errorMsg = ref("");
const available = ref([]); // 有启用源支持的平台
const qualitys = ref({}); // 各平台源声明支持的音质
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

/** 平台 chip / 来源徽标的提示：可用平台展示其源声明支持的最高音质 */
function platTitle(key) {
  if (!available.value.includes(key)) return t("online.noSource");
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
  } catch {
    available.value = [];
    qualitys.value = {};
  }
  // 默认勾选全部可用平台
  picked.value = [...available.value];
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

// ---- 右键菜单 ----
const ctx = ref({ visible: false, x: 0, y: 0, song: null });

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

function formatDuration(sec) {
  if (!sec) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

onMounted(loadPlatforms);
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

.row-grid {
  display: grid;
  grid-template-columns: 36px 1.5fr 1fr 1fr 72px 56px 88px;
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
.op-btn:hover {
  background: color-mix(in srgb, var(--teyvat-gold) 16%, transparent);
  color: var(--teyvat-gold);
}
.online-view__empty {
  text-align: center;
  color: var(--teyvat-text-secondary);
  padding: var(--space-8);
  font-size: 13px;
}
</style>
