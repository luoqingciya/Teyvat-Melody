<template>
  <AppModal :model-value="visible" :title="t('playlist.addTo')" :width="360" @update:model-value="close">
    <p class="pick__song">
      <AppIcon :name="song?.online ? 'cloud' : 'music'" :size="14" />
      <span class="pick__song-name">{{ song?.title || song?.name || "" }}</span>
      <span class="pick__song-artist">{{ song?.artist || song?.singer || "" }}</span>
    </p>

    <div v-if="playlists.length" class="pick__list">
      <button
        v-for="p in playlists"
        :key="p.id"
        class="pick__item"
        :disabled="busy"
        @click="choose(p)"
      >
        <AppIcon name="list-music" :size="15" />
        <span class="pick__item-name">{{ p.name }}</span>
        <span class="pick__item-count">{{ p.song_count ?? 0 }}</span>
      </button>
    </div>
    <p v-else class="pick__empty">{{ t("playlist.none") }}</p>

    <div class="pick__create">
      <input
        v-model="newName"
        class="ui-input pick__input"
        type="text"
        :placeholder="t('playlist.newPlaceholder')"
        @keyup.enter="createAndAdd"
      />
      <button class="ui-btn ui-btn--ghost" :disabled="busy || !newName.trim()" @click="createAndAdd">
        {{ t("playlist.create") }}
      </button>
    </div>
  </AppModal>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import AppModal from "./AppModal.vue";
import AppIcon from "./AppIcon.vue";
import { usePlaylistStore } from "@/stores/playlist";
import { useOnlineLibrary } from "@/composables/useOnlineLibrary";
import { useI18n } from "@/utils/i18n";
import { toast, toastError } from "@/utils/toast";

const props = defineProps({
  visible: { type: Boolean, default: false },
  song: { type: Object, default: null },
});
const emit = defineEmits(["close", "added"]);

const playlist = usePlaylistStore();
const online = useOnlineLibrary();
const { t } = useI18n();

const newName = ref("");
const busy = ref(false);

// store 实例叫 playlist（单数），模板里用的是复数 —— 显式导出一个 computed，
// 否则模板读到 undefined 会直接抛错（曾因此让弹窗整个渲染不出来）。
const playlists = computed(() => playlist.playlists);

watch(
  () => props.visible,
  (v) => {
    if (v) {
      newName.value = "";
      playlist.load();
    }
  }
);

function close() {
  emit("close");
}

async function addTo(playlistId, name) {
  busy.value = true;
  try {
    // 在线歌曲会先自动入库拿到本地 id（收藏 / 歌单都基于 songs.id）
    const res = await online.addToPlaylist(props.song, playlistId);
    const added = res?.data?.added ?? false;
    toast(added ? t("playlist.added", { name }) : t("playlist.alreadyIn", { name }));
    emit("added", { playlistId, added });
    close();
  } catch (e) {
    toastError(t("playlist.addFailed", { m: e.message }));
  } finally {
    busy.value = false;
  }
}

function choose(p) {
  addTo(p.id, p.name);
}

async function createAndAdd() {
  const name = newName.value.trim();
  if (!name || busy.value) return;
  busy.value = true;
  try {
    const created = await playlist.create(name);
    if (!created) throw new Error("创建歌单失败");
    await addTo(created.id, created.name);
  } catch (e) {
    toastError(t("playlist.addFailed", { m: e.message }));
    busy.value = false;
  }
}
</script>

<style scoped>
.pick__song {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-2);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--teyvat-gold) 8%, transparent);
  font-size: 13px;
  color: var(--teyvat-text-primary);
  min-width: 0;
}
.pick__song-name {
  font-weight: var(--font-weight-semibold);
  color: var(--teyvat-gold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pick__song-artist {
  color: var(--teyvat-text-secondary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pick__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow-y: auto;
}
.pick__item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--teyvat-text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background var(--t-fast), color var(--t-fast);
}
.pick__item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--teyvat-gold) 12%, transparent);
  color: var(--teyvat-gold);
}
.pick__item:disabled {
  opacity: 0.5;
  cursor: default;
}
.pick__item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick__item-count {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.pick__empty {
  text-align: center;
  color: var(--teyvat-text-secondary);
  font-size: 13px;
  padding: var(--space-4) 0;
}
.pick__create {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--teyvat-card-border);
}
.pick__input {
  flex: 1;
  min-width: 0;
}
</style>
