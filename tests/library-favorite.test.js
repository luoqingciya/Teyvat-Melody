// 收藏切换「就地更新」自检：node tests/library-favorite.test.js
//
// 为什么单独测这个：旧实现每点一次爱心就 `loadFavorites()` + `loadOnlineSongs()`
// **全量重拉两个列表**（`/api/online/library` 还没有分页，一次返回全部在线歌曲）。
// 收藏了几百首在线歌之后，每次点爱心都是一次全量往返 + 全量 decorateSongs 重算。
//
// 改成就地更新后，这里要钉住三件事：
//   ① 真的**不再**重拉列表（这是本优化的全部意义，退化了必须能被发现）；
//   ② 就地更新后各列表的收藏状态一致（不能出现"曲库页已收藏、收藏页没有"）；
//   ③ 取消收藏时从 favorites 移除、重新收藏时补回，且**不产生重复条目**。
//
// ⚠️ store 依赖 vue（响应式）与 pinia —— 这两个包只有 frontend/node_modules 里有，
//    所以 CI 的 tests job 必须先 `npm ci`（见 .github/workflows/ci.yml）。
const path = require("path");
const { pathToFileURL } = require("url");

const ok = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

// ---- fetch 桩：记录每个 URL 被请求了几次（用来断言「没有全量重拉」）----
const hits = [];
const json = (data) => ({ status: 200, json: async () => ({ code: 200, data }) });

let favoriteState = {}; // songId -> 0/1
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  hits.push(u);
  const m = u.match(/\/api\/favorites\/(\d+)$/);
  if (m && (opts?.method || "GET").toUpperCase() === "POST") {
    const id = Number(m[1]);
    favoriteState[id] = favoriteState[id] ? 0 : 1;
    return json({ song_id: id, favorite: !!favoriteState[id] });
  }
  throw new Error(`未预期的请求：${u}`);
};

const STORE_PATH = path.join(__dirname, "..", "frontend", "src", "stores", "library.js");

(async () => {
  // 用带查询串的 URL 绕过 ESM 缓存，保证反复 import 拿到的是新实例
  const mod = await import(`${pathToFileURL(STORE_PATH).href}?t=${Date.now()}`);
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());

  const store = mod.useLibraryStore();

  // 造数据：本地一首、在线两首
  const local = { id: 1, title: "本地歌", online_source: "", favorite: 0 };
  const onlineA = { id: 2, title: "在线A", online_source: "kw", online_id: "x", online_meta: "{}", favorite: 0 };
  const onlineB = { id: 3, title: "在线B", online_source: "kg", online_id: "y", online_meta: "{}", favorite: 0 };
  store.songList = [local];
  store.onlineSongs = [onlineA, onlineB];
  store.favorites = [];

  // ① 收藏一首在线歌曲：必须**只**发一个 toggle 请求，不能重拉列表
  hits.length = 0;
  const fav1 = await store.toggleFavorite(onlineA);
  ok("收藏返回 true", fav1 === true, String(fav1));
  ok(
    "只发 1 个请求（不再全量重拉 favorites / online library）",
    hits.length === 1,
    `实际 ${hits.length} 个：${hits.join(" , ")}`,
  );
  ok(
    "没有请求 /api/favorites 或 /api/online/library",
    !hits.some((u) => u === "/api/favorites" || u === "/api/online/library"),
    hits.join(" , "),
  );

  // ② 三处状态必须一致
  ok("曲库里的实例已标记收藏", onlineA.favorite === 1, String(onlineA.favorite));
  ok("onlineSongs 里那条也标记收藏", store.onlineSongs.find((s) => s.id === 2)?.favorite === 1);
  ok("favorites 里出现了这首歌", store.favorites.some((s) => s.id === 2));
  ok("favorites 计数为 1", store.favorites.length === 1, String(store.favorites.length));

  // ③ 重复收藏同一首不能产生重复条目
  await store.toggleFavorite(onlineA); // 取消
  ok("取消后 favorites 里没有了", !store.favorites.some((s) => s.id === 2));
  ok("取消后 onlineSongs 里也标记为未收藏", store.onlineSongs.find((s) => s.id === 2)?.favorite === 0);
  await store.toggleFavorite(onlineA); // 再收藏
  ok("再次收藏后 favorites 仍只有一条", store.favorites.filter((s) => s.id === 2).length === 1);
  ok("再次收藏后计数仍为 1", store.favorites.length === 1, String(store.favorites.length));

  // ④ 也支持本地歌曲（songList 里的那条）
  const localInList = store.songList.find((s) => s.id === 1);
  await store.toggleFavorite(localInList);
  ok("本地歌曲也能收藏", store.favorites.some((s) => s.id === 1));
  ok("local 实例被标记收藏", store.songList.find((s) => s.id === 1)?.favorite === 1);
  ok("收藏总数变成 2", store.favorites.length === 2, String(store.favorites.length));

  // ⑤ 收藏列表里的对象与曲库页必须是"同一个来源"（按 id 能反查到）
  const fromFav = store.favorites.find((s) => s.id === 1);
  ok("收藏里的本地歌能按 id 在 songList 里反查到", store._findById(1) !== null);
  ok("收藏条目的标题正确", fromFav?.title === "本地歌", String(fromFav?.title));

  console.log("\n自检结束");
})();
