// libraryStore：音乐库与收藏管理。
import { defineStore } from "pinia";
import { useApi } from "@/composables/useApi";

export const useLibraryStore = defineStore("library", {
  state: () => ({
    songList: [],
    favorites: [],
    filterKeyword: "",
  }),
  getters: {
    favoriteCount: (state) => state.favorites.length,
  },
  actions: {
    setSongs(songs) {
      this.songList = songs;
    },
    async load() {
      const [songsRes, favRes] = await Promise.all([
        useApi().loadSongs(),
        useApi().loadFavorites(),
      ]);
      if (songsRes?.data) this.songList = songsRes.data;
      if (favRes?.data) this.favorites = favRes.data;
    },
    async loadFavorites() {
      const res = await useApi().loadFavorites();
      if (res?.data) this.favorites = res.data;
    },
    /** 切换收藏，同步更新歌曲列表与收藏列表 */
    async toggleFavorite(song) {
      const res = await useApi().toggleFavorite(song.id);
      const fav = res?.data?.favorite ?? false;
      song.favorite = fav ? 1 : 0;
      await this.loadFavorites();
      return fav;
    },
    setKeyword(kw) {
      this.filterKeyword = kw;
    },
  },
});
