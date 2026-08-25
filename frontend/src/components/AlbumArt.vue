<template>
  <div class="album-art">
    <img v-if="src" :src="src" class="album-art__img" alt="专辑封面" />
    <div v-else class="album-art__placeholder"><AppIcon name="music" :size="52" /></div>
  </div>
</template>

<script setup>
defineProps({
  src: { type: String, default: "" },
});
</script>

<style scoped>
.album-art {
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: linear-gradient(135deg, color-mix(in srgb, var(--teyvat-gold) 15%, transparent), color-mix(in srgb, var(--teyvat-blue) 10%, transparent));
  border: 1px solid var(--teyvat-card-border);
}
.album-art__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.album-art__placeholder {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--teyvat-gold);
  opacity: 0.6;
}
</style>