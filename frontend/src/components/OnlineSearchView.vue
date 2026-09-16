<template>
  <GlassCard class="online-view">
    <div class="online-view__toolbar">
      <div class="online-view__search">
        <input
          v-model="ui.keyword"
          class="online-view__input ui-input"
          type="text"
          :placeholder="t('online.placeholder')"
          @keyup.enter="doSearch"
        />
        <button v-if="ui.keyword" class="online-view__clear" :title="t('song.clearSearch')" @click="clearKeyword">
          <AppIcon name="x" :size="13" />
        </button>
      </div>
      <button
        class="ui-btn online-view__go"
        :disabled="loading || !ui.keyword.trim() || !available.length"
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
            'plat-chip--on': ui.picked.includes(p.key),
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

    <!-- 结果条：告诉用户当前在第几页、共加载了多少条、还能不能继续翻 -->
    <div v-if="ui.results.length" class="online-view__meta">
      <span>{{ t("online.resultCount", { n: ui.results.length }) }}</span>
      <span class="online-view__meta-dot">·</span>
      <span>{{ t("online.pageInfo", { p: ui.page }) }}</span>
      <span v-if="atLimit" class="online-view__meta-limit" :title="t('online.limitTip', { n: MAX_RESULTS })">
        {{ t("online.limitReached") }}
      </span>
      <button class="online-view__meta-clear" @click="clearAll">{{ t("online.clearResult") }}</button>
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

    <div ref="scroller" class="online-view__scroll" @scroll="onScroll">
      <div
        v-for="(song, i) in ui.results"
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
            :title="
              online.isDownloaded(song)
                ? t('online.downloaded')
                : online.isDownloading(song)
                  ? t('online.downloadingPct', { p: downloadPercentOf(song) ?? 0 })
                  : t('online.download')
            "
            :aria-label="t('online.download')"
            :disabled="online.isDownloaded(song) || online.isDownloading(song)"
            @click.stop="downloadSong(song)"
          >
            <AppIcon name="download" :size="13" />
          </button>
        </span>
      </div>

      <!-- 翻页栏：贴在列表末尾，滚到底自然看到 -->
      <div v-if="ui.results.length" class="online-view__pager">
        <button class="ui-btn ui-btn--ghost pager-btn" :disabled="ui.page <= 1 || loading" @click="prevPage">
          ← {{ t("online.prevPage") }}
        </button>
        <span class="pager-info">{{ t("online.pageInfo", { p: ui.page }) }}</span>
        <button class="ui-btn pager-btn" :disabled="!canNext" @click="nextPage">
          {{ loadingMore ? t("online.loadingMore") : t("online.nextPage") }} →
        </button>
      </div>
    </div>

    <!--
      没有可用音源时是**真正的死胡同**（本仓库不内置任何音源），
      所以这里不只是显示一句话，而是给出可点的下一步（去设置里导入源脚本）。
      其余空状态（搜索中/无结果/未搜索）仍是一句提示即可。
    -->
    <EmptyState
      v-if="!ui.results.length && !loading && !available.length"
      title-key="online.noSourceTitle"
      desc-key="online.noSourceDesc"
      hint-key="online.noSourceHint"
      icon="cloud"
      :actions="[{ key: 'sources', labelKey: 'online.noSourceAction', icon: 'gear', primary: true }]"
      @action="onEmptyAction"
    />
    <div v-else-if="!ui.results.length" class="online-view__empty">{{ emptyText }}</div>

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
      @close="closeCtxMenu"
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
      @close="closePicker"
    />
  </GlassCard>
</template>

<script setup>
import { computed, nextTick, onActivated, onMounted, onUnmounted, ref, watch } from "vue";
import GlassCard from "./GlassCard.vue";
import EmptyState from "./EmptyState.vue";
import SongContextMenu from "./SongContextMenu.vue";
import PlaylistPickerModal from "./PlaylistPickerModal.vue";
import AppIcon from "./AppIcon.vue";
import { usePlayerStore } from "@/stores/player";
import { useOnlineLibrary } from "@/composables/useOnlineLibrary";
import { useOnlineSearch, PAGE_SIZE, MAX_RESULTS } from "@/stores/onlineSearch";
import { useUiStore } from "@/stores/ui";
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
const search = useOnlineSearch();
const { t } = useI18n();

// 搜索现场（结果 / 关键词 / 页码 / 已选平台）都放在 store 里：
// 路由切走时本组件会被卸载，放组件内的话回来就全丢了。
// 这里用 `ui` 指代 store 的 state，模板里少写一层前缀。
const ui = search.state;
const loading = search.loading;
const loadingMore = search.loadingMore;
const { canNext, atLimit } = search;

const available = ref([]); // 有启用源支持的平台
const qualitys = ref({}); // 各平台源声明支持的音质
// 各平台最近的解析失败记录（源声明支持、实际却解析不出地址）：提前提示，避免「搜得到却播不了」
const warnings = ref({});

const scroller = ref(null);
let scrollSaveTimer = 0;
// 当前界面上的结果属于哪一代（新搜索会换代，换代后不还原旧滚动位置）
let genAtRestore = search.resultGen.value;

const emptyText = computed(() => {
  if (loading.value) return t("online.searching");
  if (!available.value.length) return t("online.noSource");
  if (ui.errorMsg) return ui.errorMsg;
  if (!ui.searched) return t("online.hint");
  return t("online.noResult");
});

function platLabel(key) {
  return PLATFORMS.find((p) => p.key === key)?.label || key;
}

/** 空状态里的按钮：跳去设置页的「在线」分类导入音源脚本 */
function onEmptyAction(key) {
  if (key === "sources") useUiStore().openSettings("online");
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
  // 把「当前可用平台」交给 store：它负责决定是套用默认全选（用户没动过勾选）
  // 还是保留用户选择并剔掉已不可用的平台。组件不做这个判断 —— 那属于状态机语义，
  // 放 store 里才测得到（tests/online-search-store.test.js）。
  search.markPlatformsLoaded(available.value);
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
  const next = ui.picked.includes(key) ? ui.picked.filter((k) => k !== key) : [...ui.picked, key];
  // setPicked 会打上「用户动过勾选」的标记并立刻落盘 —— 平台选择因此能跨重启保留，
  // 且不会被下次的默认全选覆盖（见 store 里 pickedTouched 的注释）。
  search.setPicked(next);
}

/** 清空搜索框（保留结果，用户可能只是想改词再搜） */
function clearKeyword() {
  ui.keyword = "";
  search.persist();
}

/** 清空整个搜索现场（结果 + 关键词 + 页码） */
function clearAll() {
  search.reset();
}

/**
 * 发起搜索。
 * @param {number} page 目标页；1 = 新搜索（清空旧结果），>1 = 追加翻页
 */
async function runSearch(page) {
  const kw = ui.keyword.trim();
  if (!kw || loading.value || loadingMore.value) return;
  if (!available.value.length) {
    toastError(t("online.noSource"));
    return;
  }
  const token = search.nextToken();
  const isFirst = page <= 1;
  if (isFirst) {
    loading.value = true;
    ui.errorMsg = "";
  } else {
    loadingMore.value = true;
  }
  try {
    const api = window.pywebview?.api;
    if (!api || typeof api.searchOnline !== "function") throw new Error("当前环境不支持在线搜索");
    // picked 是 reactive 数组：跨 contextBridge 前必须转成普通值，否则结构化克隆会拒绝
    const r = await api.searchOnline(kw, toPlain(ui.picked), page);
    if (search.isStale(token)) return; // 已被后续搜索取代
    ui.searched = true;
    if (!r || !r.ok) {
      if (isFirst) ui.results = [];
      ui.errorMsg = r?.message || t("online.failed", { m: "unknown" });
      return;
    }
    const list = r.list ?? [];
    if (isFirst) {
      // 新一批结果：先把上一批的滚动位置作废，否则下面 restoreScroll 会把
      // 「上次 N 条里的位置」套到这次完全不同的结果上（用户一进来就在列表底部）。
      search.beginResultSet();
      ui.results = list;
      ui.submitted = kw;
      ui.hasMore = r.hasMore !== false && list.length > 0;
      ui.page = 1;
      // 新搜索把列表滚回顶部，否则会停在上一批结果的中间
      await nextTick();
      if (scroller.value) scroller.value.scrollTop = 0;
      search.scrollTop.value = 0;
      genAtRestore = search.resultGen.value; // 记下「这批结果」的代次
    } else {
      // 去重追加：同一首歌可能被不同平台/不同页重复返回（各平台结果本就有交叉）
      const seen = new Set(ui.results.map((s) => s.id));
      const fresh = list.filter((s) => s && !seen.has(s.id));
      ui.results.push(...fresh);
      ui.page = page;
      ui.hasMore = r.hasMore !== false && list.length > 0;
      // 到达上限：不再允许继续翻，避免内存无限增长
      if (ui.results.length >= MAX_RESULTS) ui.results = ui.results.slice(0, MAX_RESULTS);
    }
    // 单平台失败不阻断其它平台：结果照常展示，失败信息以 toast 提示
    if (r.errors?.length) toast(t("online.partialFailed", { m: r.errors.join("；") }));
    search.persist();
  } catch (e) {
    if (search.isStale(token)) return;
    if (isFirst) {
      ui.results = [];
      ui.searched = true;
    }
    ui.errorMsg = t("online.failed", { m: e.message });
  } finally {
    if (!search.isStale(token)) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function doSearch() {
  return runSearch(1);
}

function nextPage() {
  if (!canNext.value) return;
  return runSearch(ui.page + 1);
}

function prevPage() {
  if (ui.page <= 1 || loading.value) return;
  // 回上一页只能重搜：各平台都不支持「倒着查」，本地缓存整批结果又太吃内存。
  // 重搜后按页累积，等价于把结果重放一遍 —— 对用户来说结果一致。
  replayTo(ui.page - 1);
}

/** 从头重放到目标页（页码回退时用），期间只显示最后一次的结果 */
async function replayTo(targetPage) {
  const pages = Math.max(1, targetPage);
  loading.value = true;
  const token = search.nextToken();
  try {
    const api = window.pywebview?.api;
    if (!api || typeof api.searchOnline !== "function") throw new Error("当前环境不支持在线搜索");
    const all = [];
    for (let p = 1; p <= pages; p += 1) {
      const r = await api.searchOnline(ui.keyword.trim(), toPlain(ui.picked), p);
      if (search.isStale(token)) return;
      if (!r || !r.ok) throw new Error(r?.message || "unknown");
      const list = r.list ?? [];
      const seen = new Set(all.map((s) => s.id));
      all.push(...list.filter((s) => s && !seen.has(s.id)));
      if (list.length === 0) break;
    }
    ui.results = all;
    ui.page = pages;
    ui.hasMore = true;
    ui.errorMsg = "";
    search.persist();
  } catch (e) {
    if (!search.isStale(token)) ui.errorMsg = t("online.failed", { m: e.message });
  } finally {
    if (!search.isStale(token)) loading.value = false;
  }
}

function onScroll() {
  // 记录滚动位置（防抖），切页面回来时还原 —— 否则用户翻回去还得重新滚
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    if (scroller.value) search.scrollTop.value = scroller.value.scrollTop;
  }, 200);
}

/**
 * 还原滚动位置（等 DOM 把已有结果渲染出来之后）。
 *
 * ⚠️ 只在**同一批结果**内还原：`search.resultGen` 每次新搜索都会递增，
 * 变了说明结果已被换掉，旧的滚动位置没有意义（硬套会让用户落在新列表底部）。
 */
async function restoreScroll() {
  if (!ui.results.length) return;
  await nextTick();
  if (search.resultGen.value !== genAtRestore) return; // 结果已换代 → 不套旧位置
  if (scroller.value && search.scrollTop.value > 0) {
    scroller.value.scrollTop = search.scrollTop.value;
  }
}

function playAt(index) {
  if (!ui.results.length || index < 0) return;
  // 以当前结果列表为播放队列，便于 next / prev
  player.playQueue(ui.results, index);
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

/** 关闭右键菜单 / 歌单选择器。
 *  ⚠️ 不要在模板里写 `ctx.visible = false`：`ctx` 是 ref，那种写法不会真正改到响应式对象，
 *  结果是菜单/选择器**关不掉**（点外部、Esc、滚动全都失效）。统一走 .value。 */
function closeCtxMenu() {
  ctx.value.visible = false;
}
function closePicker() {
  picker.value.visible = false;
}

const ctxPercent = computed(() => {
  const p = ctx.value.song ? online.progressOf(ctx.value.song) : null;
  return p && !p.done && p.percent != null ? p.percent : null;
});

/** 某一行正在下载的进度百分比（行内按钮的 tooltip 用） */
function downloadPercentOf(song) {
  const p = online.progressOf(song);
  return p && !p.done ? p.percent ?? 0 : null;
}

function openMenu(e, song) {
  ctx.value = { visible: true, x: e.clientX, y: e.clientY, song };
}

function playCtx() {
  const s = ctx.value.song;
  ctx.value.visible = false;
  if (!s) return;
  const i = ui.results.findIndex((x) => x.id === s.id);
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
  // 上一次的搜索现场已在 store 构造时从 localStorage 恢复（含 keyword / 结果 / 页码），
  // 所以这里只需补齐平台列表与自己的滚动位置。
  await Promise.all([loadPlatforms(), online.loadMeta(true), online.loadDownloaded()]);
  restoreScroll();
});

// keep-alive 场景（若将来给 router-view 加了缓存）：重新激活时也还原滚动位置
onActivated(restoreScroll);

onUnmounted(() => {
  clearTimeout(scrollSaveTimer);
  // 卸载前把当前滚动位置落定，保证切走再回来停在原处。
  // 这里用 flushNow 而不是 persist：persist 是 400ms 防抖，而组件马上就要销毁，
  // 定时器有可能来不及触发（快切页面时尤其明显）→ 平台选择/现场就丢了。
  if (scroller.value) search.scrollTop.value = scroller.value.scrollTop;
  search.flushNow();
});

// 播放失败后刷新失败提示：让「这个平台你的源播不了」立刻反映到筛选条上，
// 而不是等用户再搜一次才发现。
watch(
  () => player.lastOnlineError,
  (err) => {
    if (err) refreshWarnings();
  }
);

// 每页条数变化时（未来可调）只需重搜一次，这里保持 1 页的语义
void PAGE_SIZE;
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

/* 结果摘要条：条数 / 页码 / 是否到上限 / 清空 */
.online-view__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  font-size: 12px;
  color: var(--teyvat-text-secondary);
  border-bottom: 1px solid var(--teyvat-card-border);
  flex-wrap: wrap;
}
.online-view__meta-dot {
  opacity: 0.5;
}
.online-view__meta-limit {
  padding: 1px 6px;
  border-radius: var(--radius-full);
  border: 1px solid color-mix(in srgb, var(--teyvat-gold) 40%, transparent);
  background: color-mix(in srgb, var(--teyvat-gold) 12%, transparent);
  color: var(--teyvat-gold);
  cursor: help;
}
.online-view__meta-clear {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--teyvat-text-secondary);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  transition: color var(--t-fast), background var(--t-fast);
}
.online-view__meta-clear:hover {
  color: var(--teyvat-danger);
  background: color-mix(in srgb, var(--teyvat-danger) 12%, transparent);
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

/* 翻页栏：贴在列表末尾 */
.online-view__pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  padding: var(--space-4);
}
.pager-btn {
  padding: 6px 16px;
  font-size: 12px;
}
.pager-info {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
  min-width: 60px;
  text-align: center;
}

.online-view__empty {
  text-align: center;
  color: var(--teyvat-text-secondary);
  padding: var(--space-8);
  font-size: 13px;
}
</style>
