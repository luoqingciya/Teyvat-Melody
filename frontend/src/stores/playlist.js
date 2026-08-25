// playlistStore：歌单管理（后端 SQLite 持久化）。
import { defineStore } from "pinia";
import { useApi } from "@/composables/useApi";

export const usePlaylistStore = defineStore("playlist", {
  state: () => ({
    playlists: [],
    currentSongs: [], // 当前打开歌单的歌曲
  }),
  actions: {
    async load() {
      const res = await useApi().loadPlaylists();
      if (res?.data) this.playlists = res.data;
    },
    async create(name) {
      const res = await useApi().createPlaylist(name);
      if (res?.data) {
        this.playlists.unshift(res.data);
        return res.data;
      }
      return null;
    },
    async remove(id) {
      await useApi().deletePlaylist(id);
      this.playlists = this.playlists.filter((p) => p.id !== id);
    },
    async loadSongs(id) {
      const res = await useApi().getPlaylistSongs(id);
      this.currentSongs = res?.data ?? [];
      return this.currentSongs;
    },
  },
});
