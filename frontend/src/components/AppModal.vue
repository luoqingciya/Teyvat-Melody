<template>
  <Teleport to="body">
    <Transition name="app-modal">
      <div v-if="modelValue" ref="panelEl" class="app-modal" role="dialog" aria-modal="true" tabindex="-1" :aria-label="title || undefined">
        <div
          class="app-modal__mask"
          @click.self="maskClosable && $emit('update:modelValue', false)"
        ></div>
        <div class="app-modal__panel" :style="panelStyle">
          <div class="app-modal__head">
            <span v-if="title" class="app-modal__title ui-heading">{{ title }}</span>
            <button class="app-modal__close ui-icon-btn" title="关闭" aria-label="关闭" @click="$emit('update:modelValue', false)">
              <AppIcon name="x" :size="16" />
            </button>
          </div>
          <div class="app-modal__body" :class="{ 'app-modal__body--fixed': height > 0 }">
            <slot />
          </div>
          <div v-if="$slots.foot || confirmText" class="app-modal__foot">
            <slot name="foot">
              <button class="app-modal__btn ui-btn ui-btn--ghost" @click="$emit('update:modelValue', false)">
                取消
              </button>
              <button class="app-modal__btn ui-btn" @click="confirm">
                {{ confirmText || "确定" }}
              </button>
            </slot>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: "" },
  confirmText: { type: String, default: "" },
  width: { type: Number, default: 380 },
  /** 固定内容区高度（px）。0 = 跟随内容自适应（默认）。
   *  多标签弹窗要传它 —— 否则切换标签时内容多少不同，弹窗会跟着一跳一跳的。 */
  height: { type: Number, default: 0 },
  maskClosable: { type: Boolean, default: true },
});
const emit = defineEmits(["update:modelValue", "confirm"]);

const panelStyle = computed(() => {
  const s = { width: props.width + "px" };
  if (props.height > 0) s.height = props.height + "px";
  return s;
});

const panelEl = ref(null);
/** 打开前的焦点元素：关闭后要还回去，否则键盘用户会"丢失位置"（焦点掉到 body） */
let lastFocused = null;

function confirm() {
  emit("confirm");
}

/** 可聚焦元素（用于初始聚焦与 Tab 循环） */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables() {
  if (!panelEl.value) return [];
  return Array.from(panelEl.value.querySelectorAll(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * 键盘可达性（此前只支持 Esc，焦点完全不管理）：
 *   · 打开时把焦点移进弹窗 —— 否则焦点仍留在背后的页面上，
 *     读屏用户根本不知道弹出了对话框、Tab 也会跑到背景里去；
 *   · Tab / Shift+Tab 在弹窗内循环（焦点陷阱），不让焦点漏到背景；
 *   · 关闭后把焦点还给打开它的那个元素。
 */
function onKey(e) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("update:modelValue", false);
    return;
  }
  if (e.key !== "Tab") return;

  const items = focusables();
  if (!items.length) {
    // 弹窗里没有可聚焦元素：把焦点摁在弹窗容器上，别让它跑出去
    e.preventDefault();
    panelEl.value?.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === panelEl.value)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

watch(
  () => props.modelValue,
  async (v) => {
    if (v) {
      lastFocused = document.activeElement;
      window.addEventListener("keydown", onKey);
      await nextTick();
      // 优先聚焦第一个可交互元素；没有则聚焦容器本身（配合 tabindex="-1"）
      const items = focusables();
      (items[0] || panelEl.value)?.focus();
    } else {
      window.removeEventListener("keydown", onKey);
      // 焦点归还：元素可能已从 DOM 移除（如列表刷新），所以要判一下 isConnected
      if (lastFocused && lastFocused.isConnected) lastFocused.focus();
      lastFocused = null;
    }
  }
);

onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<style scoped>
.app-modal {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none; /* 容器本身是 tabindex="-1" 的聚焦落点，不需要视觉描边 */
}
.app-modal__mask {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--teyvat-bg-dark) 55%, transparent);
  backdrop-filter: blur(var(--blur-soft));
}
.app-modal__panel {
  position: relative;
  width: 380px;
  max-width: 90vw;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-xl);
  border: 1px solid var(--teyvat-card-border);
  background: color-mix(in srgb, var(--teyvat-card-bg) 100%, transparent);
  backdrop-filter: blur(var(--blur-overlay));
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.app-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-5) var(--space-2);
  flex-shrink: 0; /* 固定高度弹窗里头部不能被压扁 */
}
.app-modal__body {
  padding: var(--space-3) var(--space-5) var(--space-2);
  overflow-y: auto; /* 内容超长时出现滑动条 */
  flex: 1 1 auto;
  min-height: 0;
}
/* 固定内容区高度：配合 height 属性使用，body 撑满剩余空间并独立滚动 */
.app-modal__body--fixed {
  flex: 1 1 auto;
}
.app-modal__body::-webkit-scrollbar {
  width: var(--space-2);
}
.app-modal__body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--teyvat-text-secondary) 36%, transparent);
  border-radius: var(--radius-full);
}
.app-modal__body::-webkit-scrollbar-thumb:hover {
  background: var(--teyvat-gold);
}
.app-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5) var(--space-5);
}
</style>

<style>
.app-modal-enter-active,
.app-modal-leave-active {
  transition: opacity var(--t-base);
}
.app-modal-enter-active .app-modal__panel,
.app-modal-leave-active .app-modal__panel {
  transition: transform var(--t-base);
}
.app-modal-enter-from,
.app-modal-leave-to {
  opacity: 0;
}
.app-modal-enter-from .app-modal__panel,
.app-modal-leave-to .app-modal__panel {
  transform: translateY(var(--space-3)) scale(0.96);
}
</style>