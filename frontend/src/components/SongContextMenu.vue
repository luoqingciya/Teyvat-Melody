<template>
  <Teleport to="body">
    <Transition name="ctx-menu">
      <div
        v-if="visible"
        ref="rootEl"
        class="song-ctx"
        role="menu"
        :aria-label="song?.title || song?.name || ''"
        :style="{ left: px + 'px', top: py + 'px' }"
        @contextmenu.prevent
        @keydown="onMenuKey"
      >
        <div class="song-ctx__title">
          <p class="song-ctx__name">{{ song?.title || song?.name || "" }}</p>
          <p class="song-ctx__artist">{{ song?.artist || song?.singer || t("online.unknownArtist") }}</p>
        </div>

        <button class="song-ctx__item" role="menuitem" @click="$emit('play')">
          <AppIcon :name="playing ? 'check' : 'play'" :size="15" />
          <span>{{ playing ? t("ctx.playing") : t("ctx.play") }}</span>
        </button>
        <button class="song-ctx__item" role="menuitem" @click="$emit('play-next')">
          <AppIcon name="list-music" :size="15" />
          <span>{{ t("ctx.playNext") }}</span>
        </button>
        <button class="song-ctx__item" role="menuitem" @click="$emit('add-queue')">
          <AppIcon name="add-to" :size="15" />
          <span>{{ t("ctx.addQueue") }}</span>
        </button>

        <!-- 收藏与歌单对本地 / 在线一视同仁：在线歌曲会先自动入库拿到本地 id -->
        <div class="song-ctx__divider"></div>
        <button class="song-ctx__item" role="menuitem" @click="$emit('toggle-fav')">
          <AppIcon :name="fav ? 'heart' : 'heart-outline'" :size="15" />
          <span>{{ fav ? t("ctx.unfavorite") : t("ctx.favorite") }}</span>
        </button>
        <button class="song-ctx__item" role="menuitem" @click="$emit('add-playlist')">
          <AppIcon name="list" :size="15" />
          <span>{{ t("playlist.addTo") }}</span>
        </button>

        <!-- 在线歌曲专属：音质切换与下载 -->
        <template v-if="online">
          <div class="song-ctx__divider"></div>
          <p class="song-ctx__label">{{ t("online.quality") }}</p>
          <div class="song-ctx__chips">
            <button
              v-for="q in qualityOptions"
              :key="q"
              class="quality-chip"
              :class="{ 'quality-chip--on': q === quality }"
              :title="q"
              @click="$emit('set-quality', q)"
            >
              {{ qualityLabel(q) }}
            </button>
          </div>
          <button
            class="song-ctx__item" role="menuitem"
            :disabled="downloaded || downloadPercent != null"
            @click="$emit('download')"
          >
            <AppIcon name="download" :size="15" />
            <span>
              {{
                downloaded
                  ? t("online.downloaded")
                  : downloadPercent != null
                    ? t("online.downloadingPct", { p: downloadPercent })
                    : t("online.download")
              }}
            </span>
          </button>
        </template>

        <!-- 本地歌曲专属：详情 / 编辑信息（在线歌曲没有本地文件可编辑） -->
        <template v-else>
          <div class="song-ctx__divider"></div>
          <button class="song-ctx__item" role="menuitem" @click="$emit('detail')">
            <AppIcon name="info" :size="15" />
            <span>{{ t("ctx.detail") }}</span>
          </button>
          <button class="song-ctx__item" role="menuitem" @click="$emit('edit')">
            <AppIcon name="edit" :size="15" />
            <span>{{ t("ctx.edit") }}</span>
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from "vue";
import AppIcon from "./AppIcon.vue";
import { qualityLabel } from "@/utils/onlineSong";
import { useI18n } from "@/utils/i18n";

const props = defineProps({
  visible: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  song: { type: Object, default: null },
  playing: { type: Boolean, default: false },
  fav: { type: Boolean, default: false },
  // 在线歌曲：显示「音质切换 / 下载」，隐藏「详情 / 编辑信息」（无本地文件，不适用）
  online: { type: Boolean, default: false },
  // 该平台源声明支持的音质（在线歌曲）
  qualities: { type: Array, default: () => [] },
  quality: { type: String, default: "" },
  downloaded: { type: Boolean, default: false },
  downloadPercent: { type: Number, default: null },
});
const emit = defineEmits([
  "close",
  "play",
  "play-next",
  "add-queue",
  "toggle-fav",
  "add-playlist",
  "set-quality",
  "download",
  "detail",
  "edit",
]);

const { t } = useI18n();

const rootEl = ref(null);
const px = ref(0);
const py = ref(0);

const MENU_W = 210;
const MENU_H = 320;
const GAP = 6;

// 音质选项：源声明的音质 + 一个「自动」（交给降级链挑最高可用）
const qualityOptions = ref([]);
watch(
  () => [props.qualities, props.online],
  () => {
    qualityOptions.value = props.online ? ["", ...(props.qualities || [])] : [];
  },
  { immediate: true }
);

// 限制菜单不出视口：出现后测量实际尺寸并回夹
watch(
  () => props.visible,
  async (v) => {
    if (!v) return;
    await nextTick();
    const el = rootEl.value;
    const w = el?.offsetWidth || MENU_W;
    const h = el?.offsetHeight || MENU_H;
    const maxX = window.innerWidth - w - GAP;
    const maxY = window.innerHeight - h - GAP;
    px.value = Math.min(Math.max(props.x, GAP), Math.max(GAP, maxX));
    py.value = Math.min(Math.max(props.y, GAP), Math.max(GAP, maxY));
    // 键盘唤起菜单时把焦点送进第一项，否则焦点还在列表行上，
    // ↑↓ 会被列表截走、菜单也按不了。
    items()[0]?.focus();
  },
  { immediate: true }
);

/** 菜单内可操作的项（用于 ↑↓ 导航；chips 也算，它们是音质选项） */
function items() {
  if (!rootEl.value) return [];
  return Array.from(rootEl.value.querySelectorAll("button:not([disabled])"));
}

/**
 * 菜单内键盘导航（WAI-ARIA menu 的通行键位）。
 * 原本只支持 Esc 关闭，方向键完全没处理 —— 键盘用户打开菜单后选不了任何一项。
 *   · ↑ / ↓  在项间移动（到底部回到第一项，循环）
 *   · Home/End 首尾
 */
function onMenuKey(e) {
  const list = items();
  if (!list.length) return;
  const idx = list.indexOf(document.activeElement);

  if (e.key === "ArrowDown") {
    e.preventDefault();
    list[(idx + 1) % list.length]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    list[(idx - 1 + list.length) % list.length]?.focus();
  } else if (e.key === "Home") {
    e.preventDefault();
    list[0].focus();
  } else if (e.key === "End") {
    e.preventDefault();
    list[list.length - 1].focus();
  }
}

// 点击外部 / 滚动 / Esc 关闭
let detachTimer = null;
let detachGlobal = null;

function attachGlobal() {
  detachGlobal?.();
  const onDown = (e) => {
    if (rootEl.value && rootEl.value.contains(e.target)) return;
    emit("close");
  };
  const onKey = (e) => {
    if (e.key === "Escape") emit("close");
  };
  const onWheel = () => emit("close");
  detachTimer = setTimeout(() => {
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel);
    detachGlobal = () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    };
  }, 0);
}

function detachGlobalNow() {
  clearTimeout(detachTimer);
  detachGlobal?.();
  detachGlobal = null;
}

watch(
  () => props.visible,
  (v) => {
    if (v) attachGlobal();
    else detachGlobalNow();
  }
);

onBeforeUnmount(detachGlobalNow);
</script>

<style scoped>
.song-ctx {
  position: fixed;
  z-index: 600;
  width: 210px;
  padding: var(--space-2);
  border-radius: var(--radius-lg);
  border: 1px solid var(--teyvat-card-border);
  background: color-mix(in srgb, var(--teyvat-card-bg) 24%, var(--teyvat-bg-dark) 76%);
  backdrop-filter: blur(var(--blur-overlay));
  box-shadow: var(--shadow-pop);
  user-select: none;
}
.song-ctx__title {
  padding: var(--space-2) var(--space-3) var(--space-2);
  border-bottom: 1px solid var(--teyvat-card-border);
  margin-bottom: var(--space-2);
  overflow: hidden;
}
.song-ctx__name {
  font-size: 13px;
  color: var(--teyvat-gold);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-ctx__artist {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-ctx__item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: transparent;
  color: var(--teyvat-text-primary);
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: background var(--t-fast), color var(--t-fast);
  text-align: left;
}
.song-ctx__item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--teyvat-gold) 12%, transparent);
  color: var(--teyvat-gold);
}
/* 键盘聚焦时与 hover 同样醒目（↑↓ 导航必须看得出"当前在哪一项"） */
.song-ctx__item:focus-visible {
  outline: none;
  background: color-mix(in srgb, var(--teyvat-gold) 14%, transparent);
  color: var(--teyvat-gold);
}
.song-ctx__item:hover:not(:disabled) :deep(.app-icon) {
  color: var(--teyvat-gold);
}
.song-ctx__item:disabled {
  opacity: 0.5;
  cursor: default;
}
.song-ctx__divider {
  height: 1px;
  background: var(--teyvat-card-border);
  margin: var(--space-1) var(--space-1);
}
.song-ctx__label {
  padding: 0 var(--space-3) var(--space-1);
  font-size: 11px;
  color: var(--teyvat-text-secondary);
}
.song-ctx__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 var(--space-3) var(--space-2);
}
.quality-chip {
  padding: 3px 9px;
  font-size: 11px;
  border-radius: var(--radius-full);
  border: 1px solid var(--teyvat-card-border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.quality-chip:hover {
  background: rgba(255, 255, 255, 0.14);
  color: var(--teyvat-text-primary);
}
.quality-chip--on {
  background: color-mix(in srgb, var(--teyvat-gold) 20%, transparent);
  border-color: color-mix(in srgb, var(--teyvat-gold) 50%, transparent);
  color: var(--teyvat-gold);
}
</style>

<style>
.ctx-menu-enter-active,
.ctx-menu-leave-active {
  transition: opacity var(--t-fast) ease;
}
.ctx-menu-enter-active {
  animation: ctx-pop var(--t-base) ease;
}
.ctx-menu-enter-from,
.ctx-menu-leave-to {
  opacity: 0;
}
@keyframes ctx-pop {
  from {
    transform: scale(0.94);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
</style>
