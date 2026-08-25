// 生产构建产物由 Flask 托管；开发环境中使用 proxy 代理到后端 API / 音频流。
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 开发模式下将 API 与音频流请求代理到 Flask
      "/api": { target: "http://127.0.0.1:5000", changeOrigin: true },
      "/stream": { target: "http://127.0.0.1:5000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    // 关闭自动清空：避免 Vite 的 emptyDir 触发安全删除拦截（CI/沙箱环境会拦截 rm）。
    // 旧产物已在上一步用 trash 机制清理；后续增量构建直接覆盖即可。
    emptyOutDir: false,
  },
});