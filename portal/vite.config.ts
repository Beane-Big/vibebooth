import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 本地开发时把接口请求转给网关（docker compose 启动后的 8080 端口）。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
