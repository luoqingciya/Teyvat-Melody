// 必须使用 Hash 模式：规避 file:// 协议下 History 模式的白屏 404。
import { createRouter, createWebHashHistory } from "vue-router";

const routes = [
  {
    path: "/",
    component: () => import("@/components/MainLayout.vue"),
    children: [
      { path: "", redirect: "/songs" },
      { path: "songs", name: "songs", component: () => import("@/components/SongList.vue") },
      { path: "favorites", name: "favorites", component: () => import("@/components/SongList.vue") },
      { path: "recent", name: "recent", component: () => import("@/components/SongList.vue") },
      { path: "playlists", name: "playlists", component: () => import("@/components/PlaylistHub.vue") },
      { path: "playlist/:id", name: "playlist", component: () => import("@/components/SongList.vue") },
      { path: "stats", name: "stats", component: () => import("@/components/StatsView.vue") },
      { path: "duplicates", name: "duplicates", component: () => import("@/components/DuplicatesView.vue") },
    ],
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;