import { fileURLToPath } from "node:url";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function readDevelopmentPort(
    name: string,
    fallback: number,
    worktreeEnvironment: Readonly<Record<string, string>>,
): number {
    const rawValue = process.env[name] ?? worktreeEnvironment[name];
    if (rawValue === undefined) {
        return fallback;
    }

    if (!/^\d+$/.test(rawValue)) {
        throw new Error(`${name} must be an integer TCP port`);
    }
    const port = Number(rawValue);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`${name} must be between 1 and 65535`);
    }
    return port;
}

const relayPort = readDevelopmentPort("MOBIUS_RELAY_PORT", 8787, {});
const webPort = readDevelopmentPort("MOBIUS_WEB_PORT", 5190, {});

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    server: {
        host: "127.0.0.1",
        port: webPort,
        proxy: {
            [MOBIUS_API_PREFIX]: {
                changeOrigin: true,
                target: `http://127.0.0.1:${relayPort.toString()}`,
                ws: true,
            },
        },
        strictPort: true,
    },
});
