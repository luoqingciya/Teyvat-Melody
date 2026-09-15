<template>
  <!--
    空状态引导：**不只是"这里没有内容"，而是告诉用户下一步该做什么**。
    背景：本仓库刻意不内置任何第三方音源，新用户第一次打开是空曲库 ——
    如果只显示一句"暂无歌曲"，他就卡在这里了（不知道要扫描、更不知道要导入源）。
  -->
  <div class="empty-state" role="status">
    <div class="empty-state__icon">
      <AppIcon :name="icon" :size="26" />
    </div>
    <h2 class="empty-state__title">{{ t(titleKey) }}</h2>
    <p v-if="descKey" class="empty-state__desc">{{ t(descKey) }}</p>

    <div v-if="actions.length" class="empty-state__actions">
      <button
        v-for="a in actions"
        :key="a.key"
        class="empty-state__btn"
        :class="{ 'empty-state__btn--primary': a.primary }"
        type="button"
        @click="$emit('action', a.key)"
      >
        <AppIcon v-if="a.icon" :name="a.icon" :size="15" />
        <span>{{ t(a.labelKey) }}</span>
      </button>
    </div>

    <p v-if="hintKey" class="empty-state__hint">{{ t(hintKey) }}</p>
  </div>
</template>

<script setup>
import AppIcon from "./AppIcon.vue";
import { useI18n } from "@/utils/i18n";

const { t } = useI18n();

defineProps({
  /** i18n 键：标题 */
  titleKey: { type: String, required: true },
  /** i18n 键：一句话说明（可空） */
  descKey: { type: String, default: "" },
  /** i18n 键：底部小字提示（可空） */
  hintKey: { type: String, default: "" },
  icon: { type: String, default: "music" },
  /**
   * 操作按钮：{ key, labelKey, icon?, primary? }
   * 只**发起意图**（emit action），具体怎么做由父组件决定 ——
   * 空状态不该知道"扫描"和"音源管理"分别住在哪个组件里。
   */
  actions: { type: Array, default: () => [] },
});

defineEmits(["action"]);
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-8) var(--space-6);
  text-align: center;
  user-select: none;
}

.empty-state__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  color: var(--teyvat-gold);
  background: color-mix(in srgb, var(--teyvat-gold) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--teyvat-gold) 20%, transparent);
}

.empty-state__title {
  margin: 0;
  font-size: 15px;
  font-weight: var(--font-weight-bold);
  color: var(--teyvat-text-primary);
}

.empty-state__desc {
  margin: 0;
  max-width: 46ch;
  font-size: 13px;
  line-height: 1.7;
  color: var(--teyvat-text-secondary);
}

.empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.empty-state__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  font-size: 13px;
  color: var(--teyvat-text-primary);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--teyvat-card-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--t-fast), border-color var(--t-fast);
}
.empty-state__btn:hover {
  background: rgba(255, 255, 255, 0.11);
  border-color: var(--color-border-secondary);
}
.empty-state__btn--primary {
  color: #1a1a1a;
  background: var(--teyvat-gold);
  border-color: var(--teyvat-gold);
  font-weight: var(--font-weight-bold);
}
.empty-state__btn--primary:hover {
  background: color-mix(in srgb, var(--teyvat-gold) 88%, #fff);
  border-color: color-mix(in srgb, var(--teyvat-gold) 88%, #fff);
}

.empty-state__hint {
  margin: 0;
  font-size: 12px;
  color: var(--teyvat-text-tertiary, var(--teyvat-text-secondary));
  opacity: 0.8;
}
</style>
