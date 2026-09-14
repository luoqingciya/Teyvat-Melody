// playlistStore：歌单管理（后端 SQLite 持久化）。
// 歌单里可能含在线歌曲（无本地文件），故加载后统一做形状还原。
import { defineStore } from "pinia";
import { useApi } from "@/composables/useApi";
import { decorateSongs } from "@/utils/onlineSong";

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
      this.currentSongs = decorateSongs(res?.data ?? []);
      return this.currentSongs;
    },
    /** 把歌曲加入歌单（在线歌曲需调用方先入库拿到整数 id） */
    async addSong(playlistId, songId) {
      const res = await useApi().addPlaylistSong(playlistId, songId);
      const added = res?.data?.added ?? false;
      await this.load();
      return added;
    },
  },
});
