import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json" with { type: "json" };

const executeFile = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        const fail = (error: Error): void => reject(error);
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", fail);
            resolve();
        });
    });
}

function readPort(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Test relay did not bind to a TCP port");
    }
    return address.port;
}

describe("Mobius CLI", () => {
    it("Given a CLI installation, When pair is invoked without required arguments, Then its version is printed before pairing fails", async () => {
        await expect(executeFile(process.execPath, [cliPath, "pair"], { timeout: 10_000 })).rejects.toMatchObject({
            stdout: `mobius version: ${packageMetadata.version}\n`,
            code: 1,
        });
    });

    it("Given no running daemon, When help is requested, Then the CLI lists its daemon capabilities and exits", async () => {
        const result = await executeFile(process.execPath, [cliPath, "--help"]);

        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Mobius CLI");
        expect(result.stdout).toContain("mobius pair");
        expect(result.stdout).toContain("mobius start");
        expect(result.stdout).toContain("local daemon");
    });

    it("Given a saved channel, When its daemon connects to the relay, Then the CLI highlights the exact command that reconnects that channel", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-start-cli-"));
        const stateDirectory = join(temporaryDirectory, "state");
        const connectionsDirectory = join(stateDirectory, "connections");
        const defaultWorkspace = join(temporaryDirectory, "workspace");
        const channelId = "highlighted-channel";
        const daemonToken = "a".repeat(43);
        const codexPath = join(temporaryDirectory, "codex");
        const adapterPath = join(temporaryDirectory, "codex-acp");
        const relay = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (
                request.method === "PUT" &&
                url.pathname === `${MOBIUS_API_PREFIX}/channels/${channelId}/catalog` &&
                !url.searchParams.has("token") &&
                request.headers.authorization === `Bearer ${daemonToken}`
            ) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(404);
            response.end();
        });
        const relaySockets = new Set<Duplex>();
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (
                typeof key !== "string" ||
                url.pathname !== `${MOBIUS_API_PREFIX}/v1/runtimes/connect` ||
                url.searchParams.has("token") ||
                request.headers.authorization !== `Bearer ${daemonToken}`
            ) {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            socket.on("data", (chunk: Buffer) => {
                if (chunk.byteLength > 0 && (chunk.readUInt8(0) & 0x0f) === 8) {
                    socket.end(Buffer.from([0x88, 0]));
                }
            });
        });

        try {
            await Promise.all([
                mkdir(connectionsDirectory, { mode: 0o700, recursive: true }),
                mkdir(defaultWorkspace, { mode: 0o700, recursive: true }),
                writeFile(
                    codexPath,
                    executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                    { mode: 0o700 },
                ),
                writeFile(
                    adapterPath,
                    executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                    { mode: 0o700 },
                ),
            ]);
            await Promise.all([chmod(codexPath, 0o700), chmod(adapterPath, 0o700)]);
            await listen(relay);
            await writeFile(
                join(connectionsDirectory, `${channelId}.json`),
                `${JSON.stringify(
                    {
                        defaultWorkspace,
                        channelId,
                        daemonToken,
                        relayOrigin: `http://127.0.0.1:${readPort(relay)}/`,
                    },
                    null,
                    2,
                )}\n`,
                { mode: 0o600 },
            );

            const daemonEnvironment = {
                ...process.env,
                FORCE_COLOR: "1",
                MOBIUS_GEMINI_PATH: join(temporaryDirectory, "missing-gemini"),
                MOBIUS_CODEX_ACP_PATH: adapterPath,
                MOBIUS_CODEX_PATH: codexPath,
                MOBIUS_COPILOT_PATH: join(temporaryDirectory, "missing-copilot"),
                MOBIUS_HERMES_PATH: join(temporaryDirectory, "missing-hermes"),
                MOBIUS_STATE_DIRECTORY: stateDirectory,
                MOBIUS_WORKBUDDY_PATH: join(temporaryDirectory, "missing-workbuddy"),
                NO_PROXY: "127.0.0.1,localhost",
                PATH: temporaryDirectory,
                no_proxy: "127.0.0.1,localhost",
            };
            Reflect.deleteProperty(daemonEnvironment, "NO_COLOR");
            const daemon = spawn(process.execPath, [cliPath, "start", "--channel", channelId], {
                env: daemonEnvironment,
                stdio: ["ignore", "pipe", "pipe"],
            });
            try {
                let stdout = "";
                let stderr = "";
                daemon.stderr?.on("data", (chunk: Buffer) => {
                    stderr += chunk.toString("utf8");
                });
                const expectedCommand = `npx --yes @moxt-ai/mobius start --channel ${channelId}`;
                await new Promise<void>((resolve, reject) => {
                    daemon.once("error", reject);
                    daemon.once("exit", (code) => {
                        reject(new Error(`Mobius daemon exited before connecting: ${code}\n${stderr}`));
                    });
                    daemon.stdout?.on("data", (chunk: Buffer) => {
                        stdout += chunk.toString("utf8");
                        if (stdout.includes(expectedCommand)) {
                            resolve();
                        }
                    });
                });

                expect(stdout).toContain("Mobius daemon connected to the relay.");
                expect(stdout).toContain(
                    `\u001B[1m\u001B[33mReconnect this channel later:\n  ${expectedCommand}\u001B[39m\u001B[22m`,
                );
            } finally {
                if (daemon.exitCode === null) {
                    daemon.kill("SIGTERM");
                    await new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
                }
            }
        } finally {
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a paired machine detects a local Codex CLI without its ACP adapter, When the daemon opens its first Relay connection, Then it installs and verifies the private integration automatically", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-auto-integration-cli-"));
        const stateDirectory = join(temporaryDirectory, "state");
        const connectionsDirectory = join(stateDirectory, "connections");
        const defaultWorkspace = join(temporaryDirectory, "workspace");
        const channelId = "automatic-integration-channel";
        const daemonToken = "b".repeat(43);
        const codexPath = join(temporaryDirectory, "codex");
        const npmPath = join(temporaryDirectory, "npm");
        const catalogBodies: string[] = [];
        const integrationPublished = Promise.withResolvers<void>();
        const relay = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (
                request.method === "PUT" &&
                url.pathname === `${MOBIUS_API_PREFIX}/channels/${channelId}/catalog` &&
                !url.searchParams.has("token") &&
                request.headers.authorization === `Bearer ${daemonToken}`
            ) {
                let body = "";
                request.setEncoding("utf8");
                request.on("data", (chunk: string) => {
                    body += chunk;
                });
                request.once("end", () => {
                    catalogBodies.push(body);
                    if (body.includes('"agents":[{"agentPath"') && body.includes('"id":"codex"')) {
                        integrationPublished.resolve();
                    }
                    response.writeHead(204);
                    response.end();
                });
                return;
            }
            response.writeHead(404);
            response.end();
        });
        const relaySockets = new Set<Duplex>();
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (
                typeof key !== "string" ||
                url.pathname !== `${MOBIUS_API_PREFIX}/v1/runtimes/connect` ||
                url.searchParams.has("token") ||
                request.headers.authorization !== `Bearer ${daemonToken}`
            ) {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            socket.on("data", (chunk: Buffer) => {
                if (chunk.byteLength > 0 && (chunk.readUInt8(0) & 0x0f) === 8) {
                    socket.end(Buffer.from([0x88, 0]));
                }
            });
        });

        try {
            await Promise.all([
                mkdir(connectionsDirectory, { mode: 0o700, recursive: true }),
                mkdir(defaultWorkspace, { mode: 0o700, recursive: true }),
                writeFile(
                    codexPath,
                    executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                    { mode: 0o700 },
                ),
                // The managed package registry is external to Mobius. This stateful local npm boundary
                // creates the pinned adapter artifact while Mobius still performs its production checks.
                writeFile(
                    npmPath,
                    executableSource(`
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const arguments_ = process.argv.slice(2);
const prefixIndex = arguments_.indexOf("--prefix");
const prefix = arguments_[prefixIndex + 1];
if (prefixIndex < 0 || prefix === undefined) process.exit(81);
if (!arguments_.includes("@agentclientprotocol/codex-acp@1.8.0")) process.exit(82);
const packageRoot = join(prefix, "node_modules", "@agentclientprotocol", "codex-acp");
const adapterPath = join(packageRoot, "dist", "index.js");
mkdirSync(join(adapterPath, ".."), { recursive: true });
writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
  bin: { "codex-acp": "dist/index.js" },
  name: "@agentclientprotocol/codex-acp",
  version: "1.8.0",
}));
writeFileSync(adapterPath, ${JSON.stringify(
                        executableSource(`
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  const executable = process.env.CODEX_PATH;
  if (executable === undefined) process.exit(91);
  const child = spawn(executable, [], { env: process.env, stdio: "inherit" });
  child.once("error", () => process.exit(92));
  child.once("exit", (code) => process.exit(code ?? 93));
}
`),
                    )});
chmodSync(adapterPath, 0o700);
`),
                    { mode: 0o700 },
                ),
            ]);
            await Promise.all([chmod(codexPath, 0o700), chmod(npmPath, 0o700)]);
            await listen(relay);
            await writeFile(
                join(connectionsDirectory, `${channelId}.json`),
                `${JSON.stringify(
                    {
                        defaultWorkspace,
                        channelId,
                        daemonToken,
                        relayOrigin: `http://127.0.0.1:${readPort(relay)}/`,
                    },
                    null,
                    2,
                )}\n`,
                { mode: 0o600 },
            );

            const daemonEnvironment = {
                ...process.env,
                MOBIUS_CLAUDE_PATH: join(temporaryDirectory, "missing-claude"),
                MOBIUS_CODEX_PATH: codexPath,
                MOBIUS_COPILOT_PATH: join(temporaryDirectory, "missing-copilot"),
                MOBIUS_CURSOR_PATH: join(temporaryDirectory, "missing-cursor"),
                MOBIUS_DEEPSEEK_HARNESS_PATH: join(temporaryDirectory, "missing-deepseek"),
                MOBIUS_GEMINI_PATH: join(temporaryDirectory, "missing-gemini"),
                MOBIUS_GROK_BUILD_PATH: join(temporaryDirectory, "missing-grok"),
                MOBIUS_HERMES_PATH: join(temporaryDirectory, "missing-hermes"),
                MOBIUS_OPENCODE_PATH: join(temporaryDirectory, "missing-opencode"),
                MOBIUS_PI_PATH: join(temporaryDirectory, "missing-pi"),
                MOBIUS_STATE_DIRECTORY: stateDirectory,
                MOBIUS_WORKBUDDY_PATH: join(temporaryDirectory, "missing-workbuddy"),
                NO_PROXY: "127.0.0.1,localhost",
                PATH: temporaryDirectory,
                no_proxy: "127.0.0.1,localhost",
            };
            Reflect.deleteProperty(daemonEnvironment, "MOBIUS_CODEX_ACP_PATH");
            const daemon = spawn(process.execPath, [cliPath, "start", "--channel", channelId], {
                env: daemonEnvironment,
                stdio: ["ignore", "pipe", "pipe"],
            });
            try {
                await integrationPublished.promise;

                expect(catalogBodies.some((body) => body.includes('"status":"integration_not_installed"'))).toBe(true);
                expect(catalogBodies.at(-1)).toContain('"id":"codex"');
                expect(catalogBodies.at(-1)).not.toContain('"status":"integration_not_installed"');
                const adapterMetadata = await stat(
                    join(
                        stateDirectory,
                        "adapters",
                        "codex",
                        "1.8.0",
                        "node_modules",
                        "@agentclientprotocol",
                        "codex-acp",
                        "dist",
                        "index.js",
                    ),
                );
                expect(adapterMetadata.isFile()).toBe(true);
            } finally {
                if (daemon.exitCode === null) {
                    daemon.kill("SIGTERM");
                    await new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
                }
            }
        } finally {
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given one local Agent integration is runnable, When JSON diagnostics are requested, Then ready and unavailable Agents are reported without local paths", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-agents-cli-"));
        const codexPath = join(temporaryDirectory, "codex");
        const adapterPath = join(temporaryDirectory, "codex-acp");
        try {
            await writeFile(
                codexPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            );
            await writeFile(
                adapterPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            );
            await Promise.all([chmod(codexPath, 0o700), chmod(adapterPath, 0o700)]);

            const result = await executeFile(process.execPath, [cliPath, "agents", "--json"], {
                env: {
                    ...process.env,
                    MOBIUS_GEMINI_PATH: join(temporaryDirectory, "missing-gemini"),
                    MOBIUS_DEFAULT_WORKSPACE: repositoryRoot,
                    MOBIUS_CODEX_ACP_PATH: adapterPath,
                    MOBIUS_CODEX_PATH: codexPath,
                    MOBIUS_COPILOT_PATH: join(temporaryDirectory, "missing-copilot"),
                    MOBIUS_HERMES_PATH: join(temporaryDirectory, "missing-hermes"),
                    MOBIUS_STATE_DIRECTORY: join(temporaryDirectory, "state"),
                    MOBIUS_WORKBUDDY_PATH: join(temporaryDirectory, "missing-workbuddy"),
                    PATH: temporaryDirectory,
                },
            });
            const diagnostics: unknown = JSON.parse(result.stdout);

            expect(diagnostics).toEqual({
                available: [
                    {
                        adapterVersion: "codex-acp 1.8.0",
                        agentVersion: "codex 0.153.0",
                        id: "codex",
                        label: "Codex",
                        status: "ready",
                    },
                ],
                unavailable: [
                    {
                        code: "agent_not_found",
                        id: "claude",
                        label: "Claude Code",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                    {
                        code: "agent_not_found",
                        id: "github-copilot-cli",
                        label: "GitHub Copilot CLI",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                    {
                        code: "agent_not_found",
                        id: "pi",
                        label: "Pi",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                    {
                        code: "agent_not_found",
                        id: "deepseek-harness",
                        label: "DeepSeek Harness",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                    {
                        code: "agent_not_found",
                        id: "hermes",
                        label: "Hermes Agent",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                    {
                        code: "agent_not_found",
                        id: "opencode",
                        label: "OpenCode",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                    {
                        code: "agent_not_found",
                        id: "cursor",
                        label: "Cursor CLI",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                    {
                        code: "agent_not_found",
                        id: "grok-build",
                        label: "Grok Build",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                    {
                        code: "agent_not_found",
                        id: "workbuddy",
                        label: "WorkBuddy",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                    {
                        code: "agent_not_found",
                        id: "gemini-cli",
                        label: "Gemini CLI",
                        message: "Agent executable not found",
                        recoveryCommand: "",
                        status: "missing_agent",
                    },
                ],
            });
            expect(result.stdout).not.toContain(temporaryDirectory);
            expect(result.stderr).toBe("");
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
