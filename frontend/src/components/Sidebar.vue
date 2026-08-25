<template>
  <aside class="sidebar">
    <!-- 侧栏简介品牌区 -->
    <div class="sidebar__head">
      <span class="sidebar__head-icon"><AppIcon name="map" :size="15" /></span>
      <span class="sidebar__head-label">{{ t("sidebar.continent") }}</span>
    </div>

    <nav class="sidebar__nav">
      <nav-item to="/songs" :label="t('sidebar.all')" icon="music" />
      <nav-item to="/favorites" :label="t('sidebar.favorites')" icon="heart" />
      <nav-item to="/recent" :label="t('sidebar.recent')" icon="rotate" />
      <nav-item to="/playlists" :label="t('sidebar.playlists')" icon="list" :paths="['/playlist']" />
      <nav-item to="/stats" :label="t('sidebar.stats')" icon="rotate" />
      <nav-item to="/duplicates" :label="t('sidebar.duplicates')" icon="search" />
    </nav>

    <!-- 音乐库扫描：异步进度 + 失败文件提示 -->
    <div class="sidebar__scan">
      <div class="scan-row">
        <input
          v-model="scanPath"
          class="scan-input ui-input"
          type="text"
          :placeholder="t('sidebar.pathPlaceholder')"
          @keyup.enter="scanLibrary()"
        />
        <button class="scan-browse" :title="t('sidebar.browse')" :aria-label="t('sidebar.browse')" :disabled="scanning" @click="browsePath()">
          <AppIcon name="folder" :size="16" />
        </button>
      </div>
      <button class="scan-btn ui-btn" :disabled="scanning" @click="scanLibrary()">
        {{ scanning ? t("sidebar.scanning") : t("sidebar.scan") }}
      </button>
      <!-- 扫描进度条 -->
      <div v-if="scanning" class="scan-progress">
        <div class="scan-progress__bar" :style="{ width: scanPercent + '%' }"></div>
        <span class="scan-progress__text">{{ scanDone }}/{{ scanTotal }}</span>
      </div>
      <span v-if="scanMsg" class="scan-msg">{{ scanMsg }}</span>
      <!-- 失败文件提示 -->
      <div v-if="scanFailed.length" class="scan-fail">
        <button class="scan-fail__toggle" @click="showFailed = !showFailed">
          {{ t("sidebar.failed", { n: scanFailed.length }) }} <span>{{ showFailed ? "▲" : "▼" }}</span>
        </button>
        <ul v-if="showFailed" class="scan-fail__list">
          <li v-for="(f, i) in scanFailed.slice(0, 20)" :key="i" :title="f.path">
            {{ f.error }}
          </li>
        </ul>
      </div>
    </div>

    <div class="sidebar__foot">
      <button
        v-for="th in themes"
        :key="th.key"
        class="theme-switch"
        :class="{ 'theme-switch--active': config.theme === th.key }"
        :title="t('theme.' + th.key)"
        :aria-label="t('theme.' + th.key)"
        :aria-pressed="config.theme === th.key"
        @click="config.setTheme(th.key)"
      >
        <AppIcon :name="th.icon" :size="16" />
      </button>
    </div>
  </aside>
</template>

<script setup>
import { ref, onBeforeUnmount } from "vue";
import NavItem from "./NavItem.vue";
import { useApi } from "@/composables/useApi";
import { useConfigStore } from "@/stores/config";
import { useLibraryStore } from "@/stores/library";
import { useI18n } from "@/utils/i18n";

const config = useConfigStore();
const { t } = useI18n();
const library = useLibraryStore();
const { startScan, getScanStatus, loadSongs, selectFolder } = useApi();

const scanPath = ref("");
const scanning = ref(false);
const scanMsg = ref("");
const scanPercent = ref(0);
const scanDone = ref(0);
const scanTotal = ref(0);
const scanFailed = ref([]);
const showFailed = ref(false);
let pollTimer = null;

async function browsePath() {
  const dir = await selectFolder();
  if (dir) scanPath.value = dir;
}

async function scanLibrary() {
  if (!scanPath.value.trim() || scanning.value) return;
  scanning.value = true;
  scanMsg.value = "";
  scanFailed.value = [];
  scanDone.value = 0;
  scanTotal.value = 0;
  scanPercent.value = 0;
  try {
    const { scan_id } = await startScan(scanPath.value.trim());
    await pollScan(scan_id);
  } catch (e) {
    scanMsg.value = "扫描失败：请检查路径";
    scanning.value = false;
  }
}

function pollScan(scanId) {
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const st = await getScanStatus(scanId);
        if (st) {
          scanDone.value = st.done || 0;
          scanTotal.value = st.total || 0;
          scanFailed.value = st.failed || [];
          scanPercent.value = st.total ? (st.done / st.total) * 100 : 0;
          scanMsg.value = st.current || "";
          if (st.finished) {
            scanning.value = false;
            const songsRes = await loadSongs();
            library.setSongs(songsRes.data ?? []);
            scanMsg.value = st.added > 0 ? `新增 ${st.added} 首` : "未发现新歌曲";
            resolve();
            return;
          }
        }
        pollTimer = setTimeout(tick, 400);
      } catch (e) {
        // 扫描过程中后端报错：立即收尾，避免 scanning 永远卡在"扫描中"
        scanning.value = false;
        scanMsg.value = "扫描失败：请检查扫描状态";
        resolve();
      }
    };
    tick();
  });
}

onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer);
});

const themes = [
  { key: "mondstadt", label: "蒙德", icon: "anemo" },
  { key: "liyue", label: "璃月", icon: "geo" },
  { key: "inazuma", label: "稻妻", icon: "electro" },
];
</script>

<style scoped>
.sidebar {
  width: 224px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--teyvat-card-bg);
  backdrop-filter: blur(var(--blur-header)) saturate(150%);
  -webkit-backdrop-filter: blur(var(--blur-header)) saturate(150%);
  border: 1px solid var(--teyvat-card-border);
  border-top-color: var(--teyvat-card-border-top);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.sidebar__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
  color: var(--teyvat-text-secondary);
  letter-spacing: 1px;
  padding: var(--space-1) var(--space-2);
}
.sidebar__head-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-md);
  color: var(--teyvat-gold);
  background: color-mix(in srgb, var(--teyvat-gold) 16%, transparent);
}

.sidebar__nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.sidebar__foot {
  margin-top: auto;
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-2) 0;
  border-top: 1px solid var(--teyvat-card-border);
}

.sidebar__scan {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border-top: 1px solid var(--teyvat-card-border);
}
.scan-row {
  display: flex;
  gap: var(--space-1);
}
.scan-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font-size: 12px;
}
.scan-browse {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.08);
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  transition: background var(--t-fast), color var(--t-fast), border-color var(--t-fast);
}
.scan-browse:hover {
  background: color-mix(in srgb, var(--teyvat-gold) 16%, transparent);
  color: var(--teyvat-gold);
  border-color: color-mix(in srgb, var(--teyvat-gold) 32%, transparent);
}
.scan-browse:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.scan-btn {
  padding: 7px 0;
}
.scan-msg {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
  text-align: center;
  word-break: break-all;
}
.scan-progress {
  position: relative;
  height: 14px;
  border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.scan-progress__bar {
  height: 100%;
  border-radius: var(--radius-full);
  background: linear-gradient(90deg, var(--teyvat-gold), var(--teyvat-blue));
  transition: width var(--t-base);
}
.scan-progress__text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--teyvat-text-primary);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.scan-fail {
  border-top: 1px dashed rgba(255, 255, 255, 0.14);
  padding-top: 6px;
  font-size: 11px;
}
.scan-fail__toggle {
  border: none;
  background: none;
  color: var(--teyvat-danger);
  cursor: pointer;
  padding: 2px 0;
}
.scan-fail__list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  max-height: 80px;
  overflow: auto;
}
.scan-fail__list li {
  color: var(--teyvat-text-secondary);
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.04);
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.theme-switch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.06);
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  transition: transform var(--t-base), background var(--t-base), color var(--t-base), box-shadow var(--t-base);
}
.theme-switch:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.1);
}
.theme-switch--active {
  background: color-mix(in srgb, var(--teyvat-gold) 20%, transparent);
  color: var(--teyvat-gold);
  box-shadow: inset 0 0 0 1px var(--teyvat-gold);
}
</style>
