<template>
  <Teleport to="body">
    <Transition name="app-modal">
      <div v-if="modelValue" class="app-modal" role="dialog" aria-modal="true">
        <div
          class="app-modal__mask"
          @click.self="maskClosable && $emit('update:modelValue', false)"
        ></div>
        <div class="app-modal__panel" :style="{ width: width + 'px' }">
          <div class="app-modal__head">
            <span v-if="title" class="app-modal__title ui-heading">{{ title }}</span>
            <button class="app-modal__close ui-icon-btn" title="关闭" @click="$emit('update:modelValue', false)">
              <AppIcon name="x" :size="16" />
            </button>
          </div>
          <div class="app-modal__body">
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
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: "" },
  confirmText: { type: String, default: "" },
  width: { type: Number, default: 380 },
  maskClosable: { type: Boolean, default: true },
});
const emit = defineEmits(["update:modelValue", "confirm"]);

function confirm() {
  emit("confirm");
}
</script>

<style scoped>
.app-modal {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
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
}
.app-modal__body {
  padding: var(--space-3) var(--space-5) var(--space-2);
  overflow-y: auto; /* 内容超长时出现滑动条 */
  flex: 1 1 auto;
  min-height: 0;
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