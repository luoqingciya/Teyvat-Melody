<template>
  <GlassCard class="playlist-hub">
    <div class="playlist-hub__head">
      <h3 class="playlist-hub__title ui-heading">我的歌单</h3>
      <div class="playlist-hub__actions">
        <button class="playlist-hub__import ui-btn ui-btn--ghost" title="导入歌单 (M3U)" @click="pickImportFile">
          <AppIcon name="upload" :size="14" />
          <span>导入</span>
        </button>
        <button class="playlist-hub__add ui-btn ui-btn--ghost" title="新建歌单" @click="openCreate">
          <AppIcon name="plus" :size="14" />
          <span>新建</span>
        </button>
      </div>
    </div>

    <div v-if="playlist.playlists.length" class="playlist-hub__grid">
      <router-link
        v-for="pl in playlist.playlists"
        :key="pl.id"
        :to="`/playlist/${pl.id}`"
        class="playlist-hub__card"
      >
        <button
          class="playlist-hub__export ui-icon-btn"
          :title="`导出「${pl.name}」`"
          @click.stop.prevent="exportPlaylist(pl)"
        >
          <AppIcon name="download" :size="14" />
        </button>
        <div class="playlist-hub__cover">
          <AppIcon name="disc" :size="32" />
        </div>
        <div class="playlist-hub__info">
          <span class="playlist-hub__name">{{ pl.name }}</span>
          <span class="playlist-hub__count">{{ pl.song_count || 0 }} 首歌曲</span>
        </div>
      </router-link>
    </div>

    <div v-else class="playlist-hub__empty">
      暂无歌单，点击右上角「新建」创建你的第一个歌单
    </div>

    <!-- 新建歌单弹窗 -->
    <AppModal v-model="showCreate" title="新建歌单" confirm-text="创建" @confirm="confirmCreate">
      <input
        v-model="draftName"
        class="modal-input ui-input"
        type="text"
        placeholder="请输入歌单名称"
        maxlength="30"
        @keyup.enter="confirmCreate"
      />
    </AppModal>

    <!-- 导入歌单弹窗 -->
    <AppModal
      v-model="showImport"
      title="导入歌单 (M3U)"
      confirm-text="导入"
      @confirm="confirmImport"
    >
      <p class="modal-file">
        <AppIcon name="folder" :size="15" />
        <span>{{ importFileName || "未选择文件" }}</span>
      </p>
      <div class="modal-field">
        <label class="modal-label">导入到</label>
        <select v-model="importTarget" class="modal-select ui-select">
          <option value="__new__">{{ importNewLabel }}</option>
          <option v-for="pl in playlist.playlists" :key="pl.id" :value="String(pl.id)">
            {{ pl.name }}
          </option>
        </select>
      </div>
    </AppModal>

    <input ref="fileInput" class="file-input" type="file" accept=".m3u,.m3u8,.txt,audio/x-mpegurl" @change="onFileChange" />
  </GlassCard>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import GlassCard from "./GlassCard.vue";
import AppModal from "./AppModal.vue";
import { usePlaylistStore } from "@/stores/playlist";
import { useApi } from "@/composables/useApi";

const playlist = usePlaylistStore();

const showCreate = ref(false);
const draftName = ref("");
const showImport = ref(false);
const fileInput = ref(null);
const importFileName = ref("");
const importText = ref("");
const importTarget = ref("__new__");

const importNewLabel = computed(() => {
  const base = (importFileName.value || "导入的歌单").replace(/\.(m3u8?|txt)$/i, "");
  return `新建歌单：${base}`;
});

onMounted(() => playlist.load());

function openCreate() {
  draftName.value = "";
  showCreate.value = true;
}

async function confirmCreate() {
  const name = draftName.value.trim();
  if (name) await playlist.create(name);
  showCreate.value = false;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "audio/x-mpegurl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportPlaylist(pl) {
  const res = await useApi().exportPlaylist(pl.id);
  if (res?.data?.m3u) {
    const safe = (pl.name || "playlist").replace(/[\\/:*?"<>|]/g, "_");
    downloadText(`${safe}.m3u`, res.data.m3u);
  }
}

function pickImportFile() {
  fileInput.value?.click();
}

function onFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importFileName.value = file.name;
    importText.value = String(reader.result ?? "");
    importTarget.value = "__new__";
    showImport.value = true;
  };
  reader.readAsText(file, "utf-8");
  e.target.value = "";
}

async function confirmImport() {
  const text = importText.value.trim();
  if (!text) {
    showImport.value = false;
    return;
  }
  const api = useApi();
  let targetId;
  if (importTarget.value === "__new__") {
    const created = await playlist.create(
      (importFileName.value || "导入的歌单").replace(/\.(m3u8?|txt)$/i, "")
    );
    if (!created) {
      showImport.value = false;
      return;
    }
    targetId = created.id;
  } else {
    targetId = Number(importTarget.value);
  }
  await api.importPlaylist(targetId, text);
  await playlist.load();
  showImport.value = false;
}
</script>

<style scoped>
.playlist-hub {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: var(--space-4);
  gap: var(--space-4);
}
.playlist-hub :deep(.glass-card__body) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 0;
}

.playlist-hub__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.playlist-hub__title {
  margin: 0;
  color: var(--teyvat-text-primary);
}
.playlist-hub__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.playlist-hub__add {
  background: color-mix(in srgb, var(--teyvat-gold) 15%, transparent);
  color: var(--teyvat-gold);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--teyvat-gold) 22%, transparent);
}
.playlist-hub__add:hover {
  background: color-mix(in srgb, var(--teyvat-gold) 25%, transparent);
}
.playlist-hub__import {
  background: color-mix(in srgb, var(--teyvat-blue) 15%, transparent);
  color: var(--teyvat-blue);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--teyvat-blue) 22%, transparent);
}
.playlist-hub__import:hover {
  background: color-mix(in srgb, var(--teyvat-blue) 25%, transparent);
}

.playlist-hub__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--space-3);
  overflow-y: auto;
}

.playlist-hub__card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--teyvat-text-primary) 5%, transparent);
  border: 1px solid var(--teyvat-card-border);
  transition: transform var(--t-base), background var(--t-base), border-color var(--t-base);
  text-decoration: none;
}
.playlist-hub__card:hover {
  transform: translateY(-2px);
  background: color-mix(in srgb, var(--teyvat-text-primary) 8%, transparent);
  border-color: color-mix(in srgb, var(--teyvat-gold) 35%, transparent);
}

.playlist-hub__export {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--teyvat-text-primary) 10%, transparent);
  color: var(--teyvat-text-secondary);
  opacity: 0;
  transition: opacity var(--t-fast), color var(--t-fast), background var(--t-fast);
}
.playlist-hub__card:hover .playlist-hub__export {
  opacity: 1;
}
.playlist-hub__export:hover {
  background: color-mix(in srgb, var(--teyvat-gold) 20%, transparent);
  color: var(--teyvat-gold);
}

.playlist-hub__cover {
  aspect-ratio: 1;
  border-radius: var(--radius-md);
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--teyvat-gold) 12%, transparent),
    color-mix(in srgb, var(--teyvat-blue) 12%, transparent)
  );
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--teyvat-gold);
}

.playlist-hub__info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.playlist-hub__name {
  font-size: 13px;
  color: var(--teyvat-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.playlist-hub__count {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
}

.playlist-hub__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--teyvat-text-secondary);
  font-size: 13px;
  text-align: center;
  padding: var(--space-8);
}

.modal-input,
.modal-select {
  width: 100%;
}
.modal-select {
  appearance: none;
}

.modal-file {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  font-size: 13px;
  color: var(--teyvat-text-primary);
}
.modal-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.modal-label {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}

.file-input {
  display: none;
}
</style>
