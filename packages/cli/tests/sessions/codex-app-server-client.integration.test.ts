import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexAppServerClient } from "../../src/acp/harness/codex/app-server-client.ts";
import { readCodexFullHistory } from "../../src/adapter/codex/history.ts";
import { LocalAgentDefinition } from "../../src/agent-catalog/local-agent.ts";
import { stopProcessTree } from "../../src/process/executable.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

async function appServer(responseCharacters = 1024 * 1024): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "mobius-codex-app-server-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "codex");
    await writeFile(
        executable,
        `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const result = message.method === "initialize" ? {} : "x".repeat(${responseCharacters.toString()});
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`,
        "utf8",
    );
    await chmod(executable, 0o755);
    return executable;
}

async function historyAppServer(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "mobius-codex-history-server-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "codex");
    await writeFile(
        executable,
        `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
        return;
    }
    if (message.method === "thread/read") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, cwd: ${JSON.stringify(process.cwd())} } } }) + "\\n");
        return;
    }
    const page = Number(message.params.cursor ?? 0);
    const result = {
        data: [{
            id: "turn-" + page,
            status: "completed",
            error: null,
            items: [{ id: "message-" + page, phase: "final_answer", text: "x".repeat(9 * 1024 * 1024), type: "agentMessage" }],
        }],
        nextCursor: page < 3 ? String(page + 1) : null,
    };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`,
        "utf8",
    );
    await chmod(executable, 0o755);
    return executable;
}

it("Given a long-lived Codex app-server returns more than 32 MiB across consumed messages, When another request completes, Then the healthy connection remains usable", async () => {
    const command = await appServer();
    const client = new CodexAppServerClient({
        command,
        cwd: process.cwd(),
        environment: {},
        handlers: {
            onNotification: async () => {},
            onServerRequest: async () => {},
        },
    });
    try {
        const signal = AbortSignal.timeout(30_000);
        await client.initialize(signal);
        for (let request = 0; request < 34; request += 1) {
            await expect(client.request("history/read", {}, signal)).resolves.toHaveLength(1024 * 1024);
        }
    } finally {
        client.detach();
        await stopProcessTree(client.child());
    }
});

it("Given Codex sends an individual protocol message above 32 MiB, When Mobius receives it, Then the connection stops at the bounded transport boundary", async () => {
    const command = await appServer(33 * 1024 * 1024);
    const client = new CodexAppServerClient({
        command,
        cwd: process.cwd(),
        environment: {},
        handlers: {
            onNotification: async () => {},
            onServerRequest: async () => {},
        },
    });
    try {
        const signal = AbortSignal.timeout(30_000);
        await client.initialize(signal);
        await expect(client.request("history/read", {}, signal)).rejects.toMatchObject({
            code: "codex_app_server_output_limit",
        });
    } finally {
        client.detach();
        await stopProcessTree(client.child());
    }
});

it("Given paginated Codex history exceeds 32 MiB across consumed responses, When Mobius reads every page, Then the bounded history reader completes", async () => {
    const command = await historyAppServer();
    const agent = new LocalAgentDefinition("codex", "Codex", command, []);

    await expect(
        readCodexFullHistory(agent, process.cwd(), "large-history", AbortSignal.timeout(30_000)),
    ).resolves.toMatchObject({
        history: { status: "available" },
        nativeSessionId: "large-history",
    });
});
