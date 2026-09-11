import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readWorktreeEnvironment } from "../../scripts/worktree/environment.ts";

function developmentPort(name: string, fallback: number): number {
    const worktree = readWorktreeEnvironment();
    const raw = process.env[name] ?? worktree[name];
    if (raw === undefined) {
        return fallback;
    }
    if (!/^\d+$/.test(raw)) {
        throw new Error(`${name} must be an integer TCP port`);
    }
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`${name} must be between 1 and 65535`);
    }
    return port;
}

const webPort = developmentPort("MOBIUS_WEB_PORT", 5190);
const apiPort = developmentPort("MOBIUS_DEMO_API_PORT", 9787);

export default defineConfig({
    plugins: [react()],
    server: {
        host: "127.0.0.1",
        port: webPort,
        proxy: {
            "/demo-api": {
                changeOrigin: true,
                target: `http://127.0.0.1:${apiPort.toString()}`,
            },
        },
        strictPort: true,
    },
    build: {
        outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    },
});
