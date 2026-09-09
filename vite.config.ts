import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5273,
    proxy: {
      "/api": { target: "http://127.0.0.1:7997", changeOrigin: true }
    }
  },
  build: {
    outDir: "dist",
    target: "es2022",
    emptyOutDir: true
  }
});
