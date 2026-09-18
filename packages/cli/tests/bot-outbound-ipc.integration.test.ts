import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
    BotConnectionReplyRoute,
    BotSessionPromptCommand,
    DEFAULT_AGENT_EXECUTION_CONFIGURATION,
    MOBIUS_API_PREFIX,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";

import { BotExecutionContextRegistry } from "../src/bots/bot-execution-context.ts";
import { BotOutboundIpcServer } from "../src/bots/bot-outbound-ipc.ts";

const executeFile = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

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
        throw new Error("Test Relay did not bind to a TCP port");
    }
    return address.port;
}

function command(deadline: string): BotSessionPromptCommand {
    return new BotSessionPromptCommand(
        "session_alpha",
        "message_alpha",
        "codex",
        "binding_alpha",
        "default",
        [],
        [],
        [],
        "Complete the task",
        "execution_alpha",
        "capability_alpha",
        "c".repeat(43),
        deadline,
        "bot_alpha",
        "conversation_alpha",
        "turn_alpha",
        "behavior_alpha",
        1,
        "",
        "a".repeat(64),
        [{ alias: "team-notifications", deliveryTargetId: "target_team" }],
        new BotConnectionReplyRoute("connection_alpha", "target_current"),
        DEFAULT_AGENT_EXECUTION_CONFIGURATION,
    );
}

describe("Bot outbound local IPC", () => {
    it("Given a Bot execution remains active past its start deadline, When its Agent invokes the CLI, Then the daemon forwards the scoped outbound request", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-bot-ipc-"));
        const socketPath = join(temporaryDirectory, "bot.sock");
        const requests: Array<{
            readonly authorization: string;
            readonly capability: string;
            readonly body: unknown;
            readonly path: string;
        }> = [];
        const relay = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                requests.push({
                    authorization: request.headers.authorization ?? "",
                    capability: String(request.headers["x-mobius-bot-execution-capability"] ?? ""),
                    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                    path: request.url ?? "",
                });
                response.writeHead(202, { "content-type": "application/json" });
                response.end(JSON.stringify({ duplicate: false, outboundMessageId: "out_alpha" }));
            });
        });
        await listen(relay);
        const registry = new BotExecutionContextRegistry();
        const lease = registry.activate(command("2000-01-01T00:00:00.000Z"));
        const relayUrl = new URL(`ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/channel_alpha/daemon`);
        relayUrl.searchParams.set("token", "d".repeat(43));
        const cancellation = new AbortController();
        const ipc = new BotOutboundIpcServer(socketPath, relayUrl, registry);

        try {
            await ipc.listen(cancellation.signal);
            expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
            const result = await executeFile(
                process.execPath,
                [cliPath, "bot", "message", "send", "--target", "current", "--text", "Task complete"],
                {
                    env: {
                        ...process.env,
                        MOBIUS_BOT_CONTEXT: lease.context.contextHandle,
                        MOBIUS_BOT_SOCKET: socketPath,
                    },
                },
            );

            expect(result.stderr).toBe("");
            expect(JSON.parse(result.stdout)).toEqual({ outboundMessageId: "out_alpha" });
            expect(requests).toHaveLength(1);
            expect(requests[0]).toEqual({
                authorization: `Bearer ${"d".repeat(43)}`,
                capability: "c".repeat(43),
                body: {
                    idempotencyKey: expect.stringMatching(/^cli_[a-f0-9-]{36}$/),
                    text: "Task complete",
                },
                path: `${MOBIUS_API_PREFIX}/v1/bot-executions/execution_alpha/reply-messages`,
            });
        } finally {
            lease.release();
            cancellation.abort();
            await ipc.close();
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given no active Bot execution context, When the CLI attempts an outbound message, Then it fails with execution_context_required", async () => {
        await expect(
            executeFile(
                process.execPath,
                [cliPath, "bot", "message", "send", "--target", "current", "--text", "Task complete"],
                { env: { ...process.env, MOBIUS_BOT_CONTEXT: "", MOBIUS_BOT_SOCKET: "" } },
            ),
        ).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining("execution_context_required"),
        });
    });
});
