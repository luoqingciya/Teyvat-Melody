// libraryStore：音乐库与收藏管理。
//
// 「在线歌曲入库」之后，收藏与歌单里都可能出现**在线歌曲**（无本地文件、播放走源解析）。
// 所以这里除了本地曲库，还维护一份已入库的在线歌曲表，并提供 allSongs 作为「能播的一切」
// 的统一查找池（最近播放反查、启动恢复队列都用它，否则在线条目会被静默丢掉）。
import { defineStore } from "pinia";
import { useApi } from "@/composables/useApi";
import { decorateSongs } from "@/utils/onlineSong";

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
    /**
     * 切换收藏，同步更新歌曲列表与收藏列表。
     * 在线歌曲需先入库拿到整数 id（由调用方保证，见 useOnlineLibrary.ensureRegistered）。
     *
     * ⚠️ 这里刻意**不做全量重拉**（旧实现每次点击都 loadFavorites + loadOnlineSongs）：
     *    `/api/online/library` 没有分页，一次返回全部已入库在线歌曲，
     *    全量重拉 + 全量 decorateSongs 重算，在收藏了几百首在线歌之后，
     *    **每点一次爱心都是一次全量往返**。后端 toggle 已经返回切换后的状态，
     *    所以就地改那一条即可 —— 语义完全等价，代价从 O(全库) 降到 O(1)。
     */
    async toggleFavorite(song) {
      const res = await useApi().toggleFavorite(song.id);
      const fav = res?.data?.favorite ?? false;

      // 就地更新三个可能持有这首歌曲的列表（同一个 id 可能同时出现在多处）
      this._patchFavorite(song.id, fav);
      song.favorite = fav ? 1 : 0;

      // 收藏列表增删：从收藏里取消 → 移除；新收藏 → 补进去（元素取自己知的实例，
      // 避免同一首歌在收藏页与曲库页变成两个不同对象）。
      if (fav) {
        const known = this._findById(song.id);
        if (known && !this.favorites.some((s) => s.id === song.id)) {
          this.favorites = [...this.favorites, known];
        }
      } else {
        this.favorites = this.favorites.filter((s) => s.id !== song.id);
      }
      return fav;
    },
    /** 在本地曲库 / 在线曲库中按 id 反查（用于收藏后就地补进收藏列表） */
    _findById(id) {
      return this.songList.find((s) => s.id === id) || this.onlineSongs.find((s) => s.id === id) || null;
    },
    /** 把某个 id 的收藏标记就地写到所有持有它的列表里（不重拉数据） */
    _patchFavorite(id, fav) {
      const apply = (list) => list.map((s) => (s.id === id ? { ...s, favorite: fav ? 1 : 0 } : s));
      this.songList = apply(this.songList);
      this.onlineSongs = apply(this.onlineSongs);
      this.favorites = apply(this.favorites);
    },
    setKeyword(kw) {
      this.filterKeyword = kw;
    },
  },
});
