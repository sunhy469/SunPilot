import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/antd/") || id.includes("/@ant-design/") || id.includes("/@ant-design/icons/") || id.includes("/rc-")) return "antd";
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/react-router-dom/") || id.includes("/scheduler/")) return "react";
        }
      }
    }
  },
  server: {
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:3737",
        ws: true
      },
      "/healthz": "http://127.0.0.1:3737",
      "/readyz": "http://127.0.0.1:3737"
    }
  }
});
