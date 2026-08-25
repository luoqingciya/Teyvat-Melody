<template>
  <header class="the-header">
    <div class="the-header__bar" @mousedown="headerDragStart">
      <div class="the-header__brand">
        <span class="the-header__logo"><AppIcon name="music" :size="20" /></span>
        <span class="the-header__title">{{ t("header.title") }}</span>
        <span class="the-header__sub">{{ t("header.sub") }}</span>
      </div>

      <div class="the-header__traffic">
        <button class="traffic-btn" :title="t('header.settings')" :aria-label="t('header.settings')" @click="showSettings = true"><AppIcon name="gear" :size="16" /></button>
        <button class="traffic-btn" :title="t('header.minimize')" :aria-label="t('header.minimize')" @click="win('minimize')"><AppIcon name="minimize" :size="16" /></button>
        <button class="traffic-btn" :title="t('header.maximize')" :aria-label="t('header.maximize')" @click="win('toggleMaximize')"><AppIcon name="maximize" :size="14" /></button>
        <button class="traffic-btn traffic-btn--close" :title="t('header.close')" :aria-label="t('header.close')" @click="win('close')"><AppIcon name="x" :size="15" /></button>
      </div>
    </div>
  </header>

  <SettingsModal v-model="showSettings" />
</template>

<script setup>
import { ref } from "vue";
import SettingsModal from "./SettingsModal.vue";
import { useI18n } from "@/utils/i18n";
import { usePlayerStore } from "@/stores/player";

const { t } = useI18n();
const showSettings = ref(false);

// 手动窗口拖拽：绕开 -webkit-app-region: drag。
// 背景：Chromium 在含 backdrop-filter 的窗口里会把 CSS 拖拽区错误映射到整窗并吞掉真实点击，
// 导致"任意位置可拖、按钮全部点不了"。因此完全不使用 CSS 拖拽区，改由主进程跟随光标移动窗口。
let dragging = false;
async function headerDragStart(e) {
  if (dragging) return;
  if (e.target.closest("button, a, input, select, textarea, [data-stop-drag]")) return;
  // 沉浸全屏（kiosk/原生全屏）下标题栏被 FullscreenPlayer 覆盖层遮住，正常不会走到这里；
  // 此处再兜底，保证全屏时一律不发起拖动，避免窗口被拖拽后"向内收缩"。
  if (usePlayerStore().fullscreen) return;
  dragging = true;
  try {
    const res = await window.pywebview?.api?.windowDragStart?.();
    // 主进程在原生全屏/kiosk 下返回 { ok:false }：此时不进入拖拽态、不挂 mouseup 监听。
    if (res && res.ok === false) {
      dragging = false;
      return;
    }
  } catch (_) {
    dragging = false;
    return;
  }
  window.addEventListener("mouseup", headerDragEnd, { once: true });
}
function headerDragEnd() {
  if (!dragging) return;
  dragging = false;
  window.pywebview?.api?.windowDragEnd?.();
}

// 窗口控制：在 pywebview 环境中通过 js_api 调用；无桥接时报错提示
function win(action) {
  const bridge = window.pywebview?.api;
  if (bridge?.[action]) {
    bridge[action]();
  } else {
    console.warn("当前非 pywebview 环境，无法执行窗口操作：", action);
  }
}
</script>

<style scoped>
/* 拖拽改为手动实现（见 headerDragStart / main.js win:drag-*），因此这里不写
   -webkit-app-region: drag。若写 CSS 拖拽区，Chromium 会同 backdrop-filter 冲突，
   把整窗误判为拖拽区并吞掉真实点击（按钮失效）。毛玻璃保留在标题栏父级即可。 */
.the-header {
  position: relative;
  height: 56px;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--teyvat-bg-dark) 60%, transparent);
  border-bottom: 1px solid var(--teyvat-card-border);
  backdrop-filter: blur(var(--blur-header)) saturate(150%);
  -webkit-backdrop-filter: blur(var(--blur-header)) saturate(150%);
}

/* 标题栏底部一条主题渐变细线，作为视觉分隔与强调 */
.the-header::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--teyvat-gold) 30%, var(--teyvat-blue) 70%, transparent);
  opacity: 0.5;
  pointer-events: none;
}

.the-header__bar {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-4);
  user-select: none;
  cursor: default;
}

.the-header__brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.the-header__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  color: var(--teyvat-gold);
  background: color-mix(in srgb, var(--teyvat-gold) 16%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--teyvat-gold) 24%, transparent);
}
.the-header__title {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: var(--font-weight-bold);
  letter-spacing: 3px;
  color: var(--teyvat-text-primary);
}
.the-header__sub {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
  letter-spacing: 2px;
  text-transform: uppercase;
}

.the-header__traffic {
  display: flex;
  gap: var(--space-1);
}
.traffic-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast);
}
.traffic-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--teyvat-text-primary);
}
.traffic-btn--close:hover {
  background: var(--teyvat-danger);
  color: #fff;
}

@media (max-width: 760px) {
  .the-header__sub {
    display: none;
  }
}
</style>
