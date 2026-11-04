import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// 本地开发时把接口请求转给网关（docker compose 启动后的 8080 端口）。
// 要连别的平台调试时，在 portal/.env.local 里写 API_PROXY=http://<服务器地址>:8080/ 。
// 这个文件不提交到仓库，服务器地址不要写进代码。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    proxy: {
      "/api": loadEnv(mode, ".", "").API_PROXY || "http://localhost:8080/",
    },
  },
}));
