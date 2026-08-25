<template>
  <div class="main-layout">
    <Sidebar />

    <main class="main-content">
      <router-view />
    </main>

    <!-- 右侧核心播放面板（封面 + 歌词 + 进度） -->
    <PlayerPanel />
  </div>
</template>

<script setup>
import Sidebar from "./Sidebar.vue";
import PlayerPanel from "./PlayerPanel.vue";
</script>

<style>
.main-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: var(--space-3);
  padding: var(--space-3);
}

.main-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  overflow-y: auto;
  overflow-x: hidden;
}
</style>
