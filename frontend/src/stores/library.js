// libraryStore：音乐库与收藏管理。
//
// 「在线歌曲入库」之后，收藏与歌单里都可能出现**在线歌曲**（无本地文件、播放走源解析）。
// 所以这里除了本地曲库，还维护一份已入库的在线歌曲表，并提供 allSongs 作为「能播的一切」
// 的统一查找池（最近播放反查、启动恢复队列都用它，否则在线条目会被静默丢掉）。
import { defineStore } from "pinia";
import { useApi } from "@/composables/useApi";
import { decorateSongs, isOnlineSong } from "@/utils/onlineSong";

export const useLibraryStore = defineStore("library", {
  state: () => ({
    songList: [], // 本地歌曲（音乐库列表只显示这些）
    favorites: [], // 收藏（可能含在线歌曲）
    onlineSongs: [], // 已入库的在线歌曲（收藏 / 加歌单时自动登记）
    filterKeyword: "",
  }),
  getters: {
    favoriteCount: (state) => state.favorites.length,
    /** 能播的全部歌曲（本地 + 在线），按 id 去重 —— 供「最近播放」等按 id 反查的场景使用 */
    allSongs(state) {
      const seen = new Set();
      const out = [];
      for (const s of [...state.songList, ...state.onlineSongs, ...state.favorites]) {
        if (s && !seen.has(s.id)) {
          seen.add(s.id);
          out.push(s);
        }
      }
      return out;
    },
  },
  actions: {
    setSongs(songs) {
      this.songList = songs;
    },
    async load() {
      const [songsRes, favRes, onlineRes] = await Promise.all([
        useApi().loadSongs(),
        useApi().loadFavorites(),
        useApi().loadOnlineLibrary(),
      ]);
      if (songsRes?.data) this.songList = songsRes.data;
      if (favRes?.data) this.favorites = decorateSongs(favRes.data);
      if (onlineRes?.data) this.onlineSongs = decorateSongs(onlineRes.data);
    },
    async loadFavorites() {
      const res = await useApi().loadFavorites();
      if (res?.data) this.favorites = decorateSongs(res.data);
    },
    /** 刷新已入库的在线歌曲表 */
    async loadOnlineSongs() {
      const res = await useApi().loadOnlineLibrary();
      if (res?.data) this.onlineSongs = decorateSongs(res.data);
    },
    /** 切换收藏，同步更新歌曲列表与收藏列表。
     *  在线歌曲需先入库拿到整数 id（由调用方保证，见 useOnlineLibrary.ensureRegistered）。 */
    async toggleFavorite(song) {
      const res = await useApi().toggleFavorite(song.id);
      const fav = res?.data?.favorite ?? false;
      song.favorite = fav ? 1 : 0;
      await Promise.all([this.loadFavorites(), isOnlineSong(song) ? this.loadOnlineSongs() : null]);
      return fav;
    },
    setKeyword(kw) {
      this.filterKeyword = kw;
    },
  },
});
