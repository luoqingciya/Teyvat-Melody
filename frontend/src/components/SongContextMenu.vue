<template>
  <Teleport to="body">
    <Transition name="ctx-menu">
      <div
        v-if="visible"
        ref="rootEl"
        class="song-ctx"
        :style="{ left: px + 'px', top: py + 'px' }"
        @contextmenu.prevent
      >
        <div class="song-ctx__title">
          <p class="song-ctx__name">{{ song?.title || "" }}</p>
          <p class="song-ctx__artist">{{ song?.artist || "未知艺术家" }}</p>
        </div>

        <button class="song-ctx__item" @click="$emit('play')">
          <AppIcon :name="playing ? 'check' : 'play'" :size="15" />
          <span>{{ playing ? "正在播放" : "播放" }}</span>
        </button>
        <button class="song-ctx__item" @click="$emit('play-next')">
          <AppIcon name="list-music" :size="15" />
          <span>下一首播放</span>
        </button>
        <button class="song-ctx__item" @click="$emit('add-queue')">
          <AppIcon name="add-to" :size="15" />
          <span>加入队列</span>
        </button>
        <div class="song-ctx__divider"></div>
        <button class="song-ctx__item" @click="$emit('toggle-fav')">
          <AppIcon :name="fav ? 'heart' : 'heart-outline'" :size="15" />
          <span>{{ fav ? "取消收藏" : "收藏" }}</span>
        </button>
        <button class="song-ctx__item" @click="$emit('detail')">
          <AppIcon name="info" :size="15" />
          <span>查看详情</span>
        </button>
        <button class="song-ctx__item" @click="$emit('edit')">
          <AppIcon name="edit" :size="15" />
          <span>编辑信息</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from "vue";
import AppIcon from "./AppIcon.vue";

const props = defineProps({
  visible: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  song: { type: Object, default: null },
  playing: { type: Boolean, default: false },
  fav: { type: Boolean, default: false },
});
const emit = defineEmits(["close", "play", "play-next", "add-queue", "toggle-fav", "detail", "edit"]);

const rootEl = ref(null);
const px = ref(0);
const py = ref(0);

const MENU_W = 200;
const MENU_H = 240;
const GAP = 6;

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
  },
  { immediate: true }
);

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
  width: 200px;
  padding: var(--space-2);
  border-radius: var(--radius-lg);
  border: 1px solid var(--teyvat-card-border);
  background: color-mix(in srgb, var(--teyvat-card-bg) 100%, transparent);
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
.song-ctx__item:hover {
  background: color-mix(in srgb, var(--teyvat-gold) 12%, transparent);
  color: var(--teyvat-gold);
}
.song-ctx__item:hover :deep(.app-icon) {
  color: var(--teyvat-gold);
}
.song-ctx__divider {
  height: 1px;
  background: var(--teyvat-card-border);
  margin: var(--space-1) var(--space-1);
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
