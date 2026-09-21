import { createInterface } from "node:readline";

// A scripted Codex app-server for discovery-time coverage of the in-process Agent. It answers the
// `turn/start` lifecycle Mobius drives so discovery can prove the whole handshake without the real
// binary. It is a fixture for the vendor protocol, not a second ACP Agent.
const input = createInterface({ input: process.stdin });
let initialized = false;
let nextThread = 0;
let nextTurn = 0;

function reply(id: unknown, result: unknown): void {
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(method: string, params: unknown): void {
    process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

process.on("SIGTERM", () => process.exit(0));

input.on("line", (line) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) {
        return;
    }
    const id: unknown = Reflect.get(value, "id");
    const method: unknown = Reflect.get(value, "method");
    const params: unknown = Reflect.get(value, "params");
    const readParam = (key: string): unknown =>
        typeof params === "object" && params !== null ? Reflect.get(params, key) : undefined;

    if (method === "initialize") {
        reply(id, { platformFamily: "unix", platformOs: "linux", userAgent: "scripted-codex/1.0.0" });
        return;
    }
    if (method === "initialized") {
        initialized = true;
        return;
    }
    if (!initialized) {
        process.stdout.write(`${JSON.stringify({ id, error: { code: -32002, message: "Not initialized" } })}\n`);
        return;
    }
    if (method === "thread/start") {
        nextThread += 1;
        reply(id, { thread: { cwd: readParam("cwd"), id: `thread-${nextThread.toString()}` } });
        return;
    }
    if (method === "turn/start") {
        nextTurn += 1;
        const threadId = readParam("threadId");
        const turnId = `turn-${nextTurn.toString()}`;
        reply(id, {
            turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress" },
        });
        notify("turn/started", { threadId, turn: { id: turnId, items: [], status: "inProgress" } });
        notify("item/started", {
            item: {
                command: "pwd",
                cwd: "/workspace",
                id: `item-${nextTurn.toString()}`,
                status: "inProgress",
                type: "commandExecution",
            },
            threadId,
            turnId,
        });
        notify("item/completed", {
            item: {
                aggregatedOutput: "/workspace\n",
                command: "pwd",
                cwd: "/workspace",
                exitCode: 0,
                id: `item-${nextTurn.toString()}`,
                status: "completed",
                type: "commandExecution",
            },
            threadId,
            turnId,
        });
        notify("item/completed", {
            item: {
                id: `message-${nextTurn.toString()}`,
                phase: "final_answer",
                text: "Scripted Codex answer",
                type: "agentMessage",
            },
            threadId,
            turnId,
        });
        notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "completed" } });
        return;
    }
    if (method === "turn/interrupt") {
        const threadId = readParam("threadId");
        const turnId = readParam("turnId");
        reply(id, {});
        notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "interrupted" } });
        return;
    }
    if (method === "thread/list") {
        reply(id, { data: [], nextCursor: null });
        return;
    }
    process.stdout.write(`${JSON.stringify({ id, error: { code: -32601, message: "Unsupported method" } })}\n`);
});
