<template>
  <router-link :to="to" class="nav-item" :class="{ 'nav-item--active': isActive }">
    <span class="nav-item__icon"><AppIcon :name="icon" :size="16" /></span>
    <span class="nav-item__label">{{ label }}</span>
  </router-link>
</template>

<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";

const props = defineProps({
  to: { type: String, required: true },
  label: { type: String, required: true },
  icon: { type: String, default: "music" },
  // 额外视为"激活"的路径前缀（例：歌单详情 /playlist/:id 也要高亮"我的歌单"）
  paths: { type: Array, default: () => [] },
});

const route = useRoute();
const isActive = computed(() => {
  const path = route.path;
  if (path === props.to || path.startsWith(props.to + "/")) return true;
  return (props.paths || []).some((p) => path === p || path.startsWith(p + "/"));
});
</script>

<style scoped>
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  color: var(--teyvat-text-secondary);
  transition: background var(--t-base), color var(--t-base), transform var(--t-base);
}
.nav-item:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--teyvat-text-primary);
}
.nav-item--active {
  background: linear-gradient(90deg, color-mix(in srgb, var(--teyvat-gold) 16%, transparent), transparent);
  color: var(--teyvat-gold);
  font-weight: var(--font-weight-semibold);
}
/* 激活项左侧一缕主题色装饰线 */
.nav-item--active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 18px;
  width: 3px;
  border-radius: var(--radius-full);
  background: linear-gradient(180deg, var(--teyvat-gold), var(--teyvat-blue));
}
.nav-item__icon {
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}
</style>
