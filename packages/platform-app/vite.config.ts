import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");
    const publishableKey = env["VITE_CLERK_PUBLISHABLE_KEY"];
    if (publishableKey === undefined || publishableKey.trim().length === 0) {
        throw new Error(`Set VITE_CLERK_PUBLISHABLE_KEY before building Platform in ${mode} mode.`);
    }
    const assetOrigin =
        mode === "staging"
            ? "https://assets.mobius.moxt.ws"
            : mode === "production"
              ? "https://assets.mobius.moxt.ai"
              : undefined;
    return {
        ...(assetOrigin === undefined
            ? {}
            : {
                  experimental: {
                      renderBuiltUrl: (filename: string) => `${assetOrigin}/${filename}`,
                  },
              }),
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
