import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/antd/") || id.includes("/@ant-design/") || id.includes("/rc-")) return "antd";
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/react-router-dom/") || id.includes("/scheduler/")) return "react";
        }
      }
    }
  },
  server: {
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:3737",
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Origin", "http://127.0.0.1:3737");
          });
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("Origin", "http://127.0.0.1:3737");
          });
        }
      },
      "/healthz": "http://127.0.0.1:3737",
      "/readyz": "http://127.0.0.1:3737"
    }
  }
});
