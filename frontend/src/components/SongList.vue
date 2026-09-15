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

      <!-- 来源筛选：只在「全部音乐」出现。
           本地曲库与已入库的在线歌曲混在一起时，用户需要一个办法
           「只看本地」或「只看在线」——在线歌曲要联网才播得出，行为不同应当可分。 -->
      <div v-if="showSourceFilter" class="song-filters">
        <button
          v-for="f in SOURCE_FILTERS"
          :key="f.key"
          class="src-chip"
          :class="{ 'src-chip--on': sourceFilter === f.key }"
          @click="sourceFilter = f.key"
        >
          {{ t(f.label) }}
          <span v-if="sourceCounts[f.key] != null" class="src-chip__n">{{ sourceCounts[f.key] }}</span>
        </button>
      </div>
    </div>

    <div class="song-table__head row-grid">
      <span class="col-fav"></span>
      <span class="col-idx">#</span>
      <span>{{ t("song.colSong") }}</span>
      <span>{{ t("song.colArtist") }}</span>
      <span>{{ t("song.colAlbum") }}</span>
      <span v-if="showSourceFilter" class="col-source-h">{{ t("song.colSource") }}</span>
      <span class="col-quality">{{ t("song.colQuality") }}</span>
      <span class="col-duration">{{ t("song.colDuration") }}</span>
    </div>

    <div ref="scrollEl" class="song-scroll" role="listbox" :aria-label="t('song.listLabel')" @scroll="onScroll">
      <div class="song-spacer" :style="{ height: totalHeight + 'px' }">
        <div
          v-for="(song, v) in visibleSongs"
          :key="song.id"
          class="song-row row-grid"
          :style="{ transform: `translateY(${(startIndex + v) * ROW_HEIGHT}px)` }"
          :class="{ 'song-row--active': player.currentSong?.id === song.id }"
          role="option"
          tabindex="0"
          :aria-selected="player.currentSong?.id === song.id"
          :aria-label="`${song.title} - ${song.artist || ''}`"
          @click="playAt(startIndex + v)"
          @keydown.enter.prevent="playAt(startIndex + v)"
          @keydown.space.prevent="playAt(startIndex + v)"
          @keydown="onRowKey($event, song)"
          @contextmenu.prevent="openContextMenu($event, song)"
          @focus="onRowFocus(startIndex + v)"
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
            <!-- 在线歌曲的标记：仅在**没有来源列**的页面显示。
                 「全部音乐」已经有来源列写明了平台名，再加一个「在线搜索」纯属重复；
                 而收藏/歌单/最近播放没有那一列，需要靠这个标记区分能否离线播放。 -->
            <span v-if="song.online && !showSourceFilter" class="tag-online" :title="sourceLabel(song.source)">
              {{ sourceLabel(song.source) }}
            </span>
            <span class="col-title__text">
              {{ song.title }}
            </span>
          </span>
          <span :title="song.artist || t('song.unknownArtist')">{{ song.artist || t("song.unknownArtist") }}</span>
          <span :title="song.album || '—'">{{ song.album || "—" }}</span>
          <span v-if="showSourceFilter" class="col-source">
            <span v-if="song.online" class="src-badge" :title="sourceLabel(song.source)">{{
              sourceLabel(song.source)
            }}</span>
            <span v-else class="src-local">{{ t("song.sourceLocal") }}</span>
          </span>
          <span class="col-quality" :title="qualityDetail(song)">{{ qualityLabel(song) }}</span>
          <span class="col-duration">{{ formatDuration(song.duration) }}</span>
        </div>
      </div>
    </div>

    <EmptyState
      v-if="!total"
      :title-key="emptyState.titleKey"
      :desc-key="emptyState.descKey || ''"
      :hint-key="emptyState.hintKey || ''"
      :icon="emptyState.icon || 'music'"
      :actions="emptyState.actions || []"
      @action="onEmptyAction"
    />

    <SongContextMenu
      :visible="ctx.visible"
      :x="ctx.x"
      :y="ctx.y"
      :song="ctx.song"
      :playing="player.currentSong?.id === ctx.song?.id"
      :fav="!!ctx.song?.favorite"
      :online="!!ctx.song?.online"
      :qualities="ctx.song?.online ? online.qualitiesFor(ctx.song.source) : []"
      :quality="ctx.song?.quality || ''"
      :downloaded="ctx.song?.online ? online.isDownloaded(ctx.song) : false"
      :download-percent="ctxPercent"
      @close="ctx.visible = false"
      @play="playCtx"
      @play-next="playNextCtx"
      @add-queue="addQueueCtx"
      @toggle-fav="toggleFavCtx"
      @add-playlist="addPlaylistCtx"
      @set-quality="setQualityCtx"
      @download="downloadCtx"
      @detail="openDetail"
      @edit="openEdit"
    />
    <PlaylistPickerModal
      :visible="picker.visible"
      :song="picker.song"
      @close="picker.visible = false"
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
import EmptyState from "./EmptyState.vue";
import SongContextMenu from "./SongContextMenu.vue";
import SongDetailModal from "./SongDetailModal.vue";
import SongEditModal from "./SongEditModal.vue";
import PlaylistPickerModal from "./PlaylistPickerModal.vue";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistStore } from "@/stores/playlist";
import { usePlayerStore } from "@/stores/player";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { useOnlineLibrary } from "@/composables/useOnlineLibrary";
import { useI18n } from "@/utils/i18n";
import { qualityLabel as qualityText } from "@/utils/onlineSong";

const ROW_HEIGHT = 52; // 行高（px），与 CSS 保持一致
const OVERSCAN = 6; // 上下额外渲染行数

const route = useRoute();
const library = useLibraryStore();
const playlist = usePlaylistStore();
const player = usePlayerStore();
const config = useConfigStore();
const ui = useUiStore();
const online = useOnlineLibrary();
const { t } = useI18n();

const keyword = ref("");
const scrollEl = ref(null);
const scrollTop = ref(0);
const viewHeight = ref(0);

// 最近播放：按 config.recentSongs 中的 id 顺序反查。
// 查找池用 allSongs（含已入库的在线歌曲）—— 在线歌曲入库后同样会进最近播放。
const recentSongs = computed(() => {
  const map = new Map(library.allSongs.map((s) => [s.id, s]));
  return config.recentSongs.map((id) => map.get(id)).filter(Boolean);
});

// 「全部音乐」= 本地曲库 + 已入库的在线歌曲。
//
// 为什么在这里合：在线歌曲入库后，收藏 / 歌单 / 最近播放里都能出现它们，
// 但「全部音乐」此前只列本地曲库 —— 用户会觉得「我下的歌、我收藏的怎么不在全部里」。
// 两者混排后必须能区分（在线歌要联网才播得出），所以加了来源列与来源筛选。
//
// ⚠️ 顺序：本地在前、在线在后。不是为了好看 —— 本地歌曲是「一定播得出来」的那批，
// 让它们先占住列表前部，用户点第一首的失败概率最低。
const allSongs = computed(() => [...library.songList, ...library.onlineSongs]);

// 来源筛选只在「全部音乐」（路由 name = songs）出现；
// 收藏/歌单/最近播放本来就有明确语义，不需要再按来源筛。
const showSourceFilter = computed(() => route.name === "songs");

const SOURCE_FILTERS = [
  { key: "all", label: "song.filterAll" },
  { key: "local", label: "song.filterLocal" },
  { key: "online", label: "song.filterOnline" },
];
const sourceFilter = ref("all");

// 各筛选下的条数（显示在 chip 上，避免用户点进去才发现是空的）
const sourceCounts = computed(() => ({
  all: allSongs.value.length,
  local: library.songList.length,
  online: library.onlineSongs.length,
}));

/** 在线歌曲的平台名（来源列显示） */
function sourceLabel(key) {
  const map = { kw: "酷我", kg: "酷狗", tx: "QQ音乐", wy: "网易云" };
  return map[key] || key || "在线";
}

// 按路由选取数据源
const baseSongs = computed(() => {
  if (route.name === "favorites") return library.favorites;
  if (route.name === "recent") return recentSongs.value;
  if (route.name === "playlist") return playlist.currentSongs;
  // 「全部音乐」：本地 + 在线，再按来源筛选
  if (sourceFilter.value === "local") return library.songList;
  if (sourceFilter.value === "online") return library.onlineSongs;
  return allSongs.value;
});

// 搜索过滤
const songs = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return baseSongs.value;
  return baseSongs.value.filter((s) =>
    [s.title, s.artist, s.album].some((f) => String(f ?? "").toLowerCase().includes(kw))
  );
});

/**
 * 空状态：按路由给出**下一步该做什么**，而不是一句"暂无歌曲"。
 *
 * 分两种情形，别混：
 *   · 收藏 / 最近播放 / 歌单 为空 —— 用户已经会用这个软件了（他知道这些页是干嘛的），
 *     只需要一句说明，不该给他看"扫描音乐库"那一套引导。
 *   · 「全部音乐」为空 —— **这才是真正的首次使用**（曲库一首歌都没有），
 *     此时要给出可点的下一步（扫描 / 导入音源），否则新用户直接卡死：
 *     本仓库刻意不内置任何音源，他连"要去哪弄源"都无从知道。
 */
const emptyState = computed(() => {
  if (route.name === "favorites") return { titleKey: "song.emptyFav" };
  if (route.name === "recent") return { titleKey: "song.emptyRecent" };
  if (route.name === "playlist") return { titleKey: "song.emptyPlaylist" };

  // 只有本地**和**在线都空，才算"全新用户"；否则只是当前筛选没有内容
  const brandNew = !library.songList.length && !library.onlineSongs.length;
  if (!brandNew) {
    // 有内容但被搜索/筛选滤空了 —— 给一句准确的话，不要引导去扫描（他明明有歌）
    if (sourceFilter.value === "online") return { titleKey: "song.emptyFilterOnline" };
    if (sourceFilter.value === "local") return { titleKey: "song.emptyFilterLocal" };
    return { titleKey: "song.emptySearch" };
  }

  return {
    titleKey: "song.welcomeTitle",
    descKey: "song.welcomeDesc",
    hintKey: "song.welcomeHint",
    icon: "music",
    primaryAction: "scan",
    actions: [
      { key: "scan", labelKey: "song.welcomeScan", icon: "folder", primary: true },
      { key: "sources", labelKey: "song.welcomeSources", icon: "cloud" },
    ],
  };
});

/** 空状态里的按钮：只发起界面意图，具体在哪实现由对应组件负责（见 stores/ui.js） */
function onEmptyAction(key) {
  if (key === "scan") ui.requestFocusScanInput();
  else if (key === "sources") ui.openSettings("online");
}

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

/**
 * 列表行的键盘操作。
 *
 * 背景：整行原本只能鼠标点（`div` + `@click`），键盘用户完全用不了 —— 播放、
 * 右键菜单都够不着。这里补上通行做法：
 *   · ↑ / ↓  在行间移动焦点（列表本来就是纵向的）
 *   · Home/End 跳到首尾
 *   · Shift+F10 或 ContextMenu 键 = 右键菜单（Windows 上的标准快捷键）
 *   · Enter / 空格 播放（在模板里绑定）
 *
 * ⚠️ 移动焦点要先把目标行**滚进可视区**：列表是虚拟滚动，
 *    焦点行若在窗口之外，它根本没被渲染出来，也就 focus() 不到。
 */
function onRowKey(e, song) {
  const cur = startIndex.value + visibleSongs.value.findIndex((s) => s.id === song.id);
  let next = null;
  if (e.key === "ArrowDown") next = cur + 1;
  else if (e.key === "ArrowUp") next = cur - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = total.value - 1;
  else if (e.key === "F10" && e.shiftKey) {
    // 键盘唤起右键菜单：菜单需要坐标，用该行的位置代替鼠标位置
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    ctx.value = { visible: true, x: rect.left + 40, y: rect.top + rect.height / 2, song };
    return;
  } else if (e.key === "ContextMenu") {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    ctx.value = { visible: true, x: rect.left + 40, y: rect.top + rect.height / 2, song };
    return;
  } else return;

  if (next === null || next < 0 || next >= total.value) return;
  e.preventDefault();
  focusRow(next);
}

/** 把焦点移到第 index 行（必要时先滚动，让该行进入渲染窗口） */
async function focusRow(index) {
  const el = scrollEl.value;
  if (!el) return;
  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  // 目标行不在可视区内 → 先滚动再聚焦（否则虚拟列表还没渲染这一行）
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  await nextTick();
  const rows = el.querySelectorAll(".song-row");
  const target = rows[index - startIndex.value];
  target?.focus();
}

/** 行获得焦点时把它滚进可视区（鼠标滚轮 + Tab 聚焦混用时也能看到焦点在哪） */
function onRowFocus(index) {
  const el = scrollEl.value;
  if (!el) return;
  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
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
  // 在线歌曲没有本地编码信息，展示的是「首选音质」（源声明的标识）
  // ⚠️ 早先无音质时返回 t("online.colSource")（=「来源」），那是把列名当值填进音质列。
  if (song.online) return song.quality ? qualityText(song.quality) : t("song.qualityUnknown");
  // 本地歌曲：列里只放**最关键的一档**（码率），完整参数留给 title 悬浮 ——
  // 早先是 "MP3 : 128000k · 44.1kHz" 这种探测结果直出，列宽被撑爆且没法一眼比较。
  return localQualityShort(song) || "—";
}

/** 本地歌曲音质的完整描述（悬浮提示用，比列内文案详细） */
function qualityDetail(song) {
  if (song.online) return qualityLabel(song);
  const parts = [];
  if (song.format) parts.push(String(song.format).toUpperCase());
  if (song.bitrate) parts.push(`${Math.round(song.bitrate)}k`);
  if (song.sample_rate) parts.push(`${(song.sample_rate / 1000).toFixed(1)}kHz`);
  return parts.join(" · ") || "—";
}

/** 列内短文案：优先码率（可与在线歌曲的 320K/FLAC 直接比较），无码率则退回格式名 */
function localQualityShort(song) {
  if (song.bitrate) return `${Math.round(song.bitrate / 1000)}K`; // 128000 → 128K
  if (song.format) return String(song.format).toUpperCase();
  return "";
}

// ---- 在线歌曲：加入歌单 / 换音质 / 下载 ----
const picker = ref({ visible: false, song: null });

const ctxPercent = computed(() => {
  const p = ctx.value.song ? online.progressOf(ctx.value.song) : null;
  return p && !p.done && p.percent != null ? p.percent : null;
});

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
  if (s) online.download(s, s.quality);
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
  // 收藏 / 歌单里可能含在线歌曲：加载平台音质声明与「已下载」标记，供右键菜单使用
  online.loadMeta();
  online.loadDownloaded();
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
/* 「全部音乐」多一列来源（本地/平台名）。用 :has 判定表头里有没有来源列 ——
   比给每一行都加一个类名更省事，且不可能出现「表头有列、行没列」的错位。 */
.song-table__head:has(.col-source-h),
.song-scroll:has(.col-source) .song-row {
  grid-template-columns: 34px 36px 1.4fr 1fr 1fr 76px minmax(96px, auto) 56px;
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
  /* 表头要有实体感：只有一条下边框时，滚动中的行会「顶进」表头看不出分界。
     加一层极淡底色 + 字母间距，让列标题与数据行明确分层。 */
  background: rgba(255, 255, 255, 0.03);
  letter-spacing: 0.02em;
  font-weight: 500;
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
/* 键盘焦点可见：整行是 tabindex=0 的可聚焦元素，必须让人看得出焦点在哪一行。
   用 :focus-visible 而不是 :focus —— 鼠标点击时不要出现描边（pointing device 场景下很吵）。 */
.song-row:focus-visible {
  outline: 2px solid var(--teyvat-gold);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--teyvat-gold) 8%, transparent);
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
/* 在线歌曲标记：收藏 / 歌单 / 最近播放里混有在线条目时一眼可辨 */
.tag-online {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 10px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--teyvat-blue) 22%, transparent);
  color: var(--teyvat-text-primary);
  border: 1px solid color-mix(in srgb, var(--teyvat-blue) 40%, transparent);
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
/* ---- 来源筛选（仅「全部音乐」） ---- */
.song-filters {
  display: flex;
  gap: var(--space-1);
  margin-left: auto; /* 贴右，与搜索框分列两端 */
}
.src-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--teyvat-card-border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.src-chip:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--teyvat-text-primary);
}
.src-chip--on {
  background: color-mix(in srgb, var(--teyvat-gold) 18%, transparent);
  border-color: color-mix(in srgb, var(--teyvat-gold) 45%, transparent);
  color: var(--teyvat-gold);
}
/* chip 上的条数：让用户点之前就知道会不会是空的 */
.src-chip__n {
  font-size: 11px;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
/* ---- 来源列 ---- */
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
.src-local {
  /* 「本地」是绝大多数行的值，不需要抢眼，但也不能淡到看不清 ——
     原先是 opacity .7 + secondary 色，实际对比度偏低，扫列时几乎看不见。 */
  font-size: 11px;
  color: var(--teyvat-text-secondary);
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
