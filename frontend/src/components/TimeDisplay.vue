<template>
  <span class="time-display">{{ time || "--:--" }}</span>
</template>

<script setup>
defineProps({
  time: { type: String, default: "" },
});
</script>