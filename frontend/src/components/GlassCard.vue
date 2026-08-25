<template>
  <section class="glass-card" :class="[`glass-card--${variant}`, { 'glass-card--interactive': interactive }]">
    <header v-if="title || $slots.extra" class="glass-card__header">
      <span v-if="title" class="glass-card__title">{{ title }}</span>
      <slot name="extra" />
    </header>
    <div class="glass-card__body">
      <slot />
    </div>
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, default: "" },
  variant: {
    type: String,
    default: "default", // default / primary / subtle
    validator: (v) => ["default", "primary", "subtle"].includes(v),
  },
  interactive: { type: Boolean, default: false },
});
</script>

<style scoped>
.glass-card {
  background: var(--teyvat-card-bg);
  backdrop-filter: blur(var(--blur-card)) saturate(150%) brightness(1.05);
  -webkit-backdrop-filter: blur(var(--blur-card)) saturate(150%) brightness(1.05);
  border: 1px solid var(--teyvat-card-border);
  border-top-color: var(--teyvat-card-border-top);
  border-left-color: color-mix(in srgb, var(--teyvat-card-border-top) 70%, transparent);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.glass-card--primary {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--teyvat-gold) 16%, transparent),
    color-mix(in srgb, var(--teyvat-blue) 12%, transparent)
  );
}

.glass-card--subtle {
  background: rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(var(--blur-header)) saturate(140%);
  -webkit-backdrop-filter: blur(var(--blur-header)) saturate(140%);
}

.glass-card--interactive {
  transition: transform var(--t-base), box-shadow var(--t-base), border-color var(--t-base);
  cursor: pointer;
}
.glass-card--interactive:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-pop);
  border-color: color-mix(in srgb, var(--teyvat-gold) 32%, transparent);
}

.glass-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) var(--space-3);
  border-bottom: 1px solid color-mix(in srgb, var(--teyvat-card-border) 70%, transparent);
}
.glass-card__title {
  font-weight: var(--font-weight-semibold);
  letter-spacing: 1px;
  color: var(--teyvat-text-primary);
}

.glass-card__body {
  padding: var(--space-4);
}
</style>
