<template>
  <div class="playlist-group">
    <div class="playlist-group__head">
      <span class="playlist-group__title">我的歌单</span>
      <button class="playlist-group__add" title="新建歌单" @click="openCreate">
        <AppIcon name="plus" :size="14" />
      </button>
    </div>

    <ul v-if="playlists.length" class="playlist-group__list">
      <li v-for="pl in playlists" :key="pl.id" class="playlist-group__item">
        <router-link :to="`/playlist/${pl.id}`">
          {{ pl.name }}<span class="playlist-group__count">{{ pl.song_count }}</span>
        </router-link>
        <button class="playlist-group__del" title="删除歌单" @click="askDelete(pl)">
          <AppIcon name="x" :size="13" />
        </button>
      </li>
    </ul>
    <div v-else class="playlist-group__empty">暂无歌单</div>

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

    <!-- 删除歌单确认弹窗 -->
    <AppModal v-model="showDelete" title="删除歌单" confirm-text="删除" @confirm="confirmDelete">
      <p class="modal-text">确定要删除歌单「{{ pendingDelete?.name }}」吗？该操作无法撤销。</p>
    </AppModal>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { storeToRefs } from "pinia";
import AppModal from "./AppModal.vue";
import { usePlaylistStore } from "@/stores/playlist";

const playlist = usePlaylistStore();
const { playlists } = storeToRefs(playlist);

const showCreate = ref(false);
const showDelete = ref(false);
const draftName = ref("");
const pendingDelete = ref(null);

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

function askDelete(pl) {
  pendingDelete.value = pl;
  showDelete.value = true;
}

async function confirmDelete() {
  if (pendingDelete.value) await playlist.remove(pendingDelete.value.id);
  showDelete.value = false;
  pendingDelete.value = null;
}
</script>

<style scoped>
.playlist-group {
  border-top: 1px solid var(--teyvat-card-border);
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.playlist-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-1);
}
.playlist-group__title {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
}
.playlist-group__add {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--teyvat-text-primary) 8%, transparent);
  color: var(--teyvat-text-primary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--t-fast);
}
.playlist-group__add:hover {
  background: color-mix(in srgb, var(--teyvat-gold) 20%, transparent);
}
.playlist-group__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.playlist-group__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-radius: 8px;
  padding: var(--space-1) 6px;
  font-size: 13px;
}
.playlist-group__item:hover {
  background: color-mix(in srgb, var(--teyvat-text-primary) 5%, transparent);
}
.playlist-group__item a {
  color: var(--teyvat-text-primary);
  text-decoration: none;
  flex: 1;
}
.playlist-group__item a.router-link-active {
  color: var(--teyvat-gold);
}
.playlist-group__count {
  font-size: 11px;
  color: var(--teyvat-text-secondary);
  margin-left: 6px;
}
.playlist-group__del {
  visibility: hidden;
  border: none;
  background: none;
  color: var(--teyvat-text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  padding: 2px;
}
.playlist-group__item:hover .playlist-group__del {
  visibility: visible;
}
.playlist-group__del:hover {
  color: var(--teyvat-danger);
}
.playlist-group__empty {
  font-size: 12px;
  color: var(--teyvat-text-secondary);
  padding: var(--space-1);
}
.modal-input {
  width: 100%;
  box-sizing: border-box;
}
.modal-text {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--teyvat-text-primary);
}
</style>