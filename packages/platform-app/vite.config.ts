import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");
    // biome-ignore lint/complexity/useLiteralKeys: Vite's environment contract uses an index signature.
    const publishableKey = env["VITE_CLERK_PUBLISHABLE_KEY"];
    if (publishableKey === undefined || publishableKey.trim().length === 0) {
        throw new Error(`Set VITE_CLERK_PUBLISHABLE_KEY before building Platform in ${mode} mode.`);
    }
    return {
        plugins: [react(), tailwindcss()],
        server: {
            host: "127.0.0.1",
            port: 5190,
            strictPort: true,
        },
        build: {
            outDir: fileURLToPath(new URL("./dist", import.meta.url)),
        },
    };
});
