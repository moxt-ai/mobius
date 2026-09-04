import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/health": "http://127.0.0.1:8787",
      "/v1": {
        changeOrigin: true,
        target: "http://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
