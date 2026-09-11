import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        host: "127.0.0.1",
        port: 5190,
        strictPort: true,
    },
    build: {
        outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    },
});
