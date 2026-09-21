import { createInterface } from "node:readline";

// A scripted Codex app-server for discovery-time coverage of the in-process Agent. It answers the
// `turn/start` lifecycle Mobius drives so discovery can prove the whole handshake without the real
// binary. It is a fixture for the vendor protocol, not a second ACP Agent.
const input = createInterface({ input: process.stdin });
let initialized = false;
let nextThread = 0;
let nextTurn = 0;

// The catalog Mobius turns into the model and reasoning effort settings. Shaped like a real
// `model/list` reply, including the fields Mobius reads for labels, effort choices, and the speed
// tier that gates fast mode. Only `scripted-small` advertises fast, so the fast mode setting appears
// for one model and not the other.
const MODELS = [
    {
        additionalSpeedTiers: ["fast"],
        defaultReasoningEffort: "medium",
        description: "Fast model for scripted turns",
        displayName: "Scripted Small",
        id: "scripted-small",
        isDefault: true,
        supportedReasoningEfforts: [
            { description: "Least reasoning", reasoningEffort: "low" },
            { description: "Balanced reasoning", reasoningEffort: "medium" },
            { description: "Most reasoning", reasoningEffort: "high" },
        ],
    },
    {
        additionalSpeedTiers: [],
        defaultReasoningEffort: "high",
        description: "Deeper model for scripted turns",
        displayName: "Scripted Large",
        id: "scripted-large",
        isDefault: false,
        supportedReasoningEfforts: [{ description: "Most reasoning", reasoningEffort: "high" }],
    },
];

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
    if (method === "model/list") {
        reply(id, { data: MODELS, nextCursor: null });
        return;
    }
    if (method === "thread/start") {
        nextThread += 1;
        // A real app-server reports the model and effort it resolved from Codex's own configuration;
        // Mobius reads them back as the current settings values.
        reply(id, {
            model: "scripted-small",
            reasoningEffort: "medium",
            thread: { cwd: readParam("cwd"), id: `thread-${nextThread.toString()}` },
        });
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
                // The turn reports what it actually ran with, so a caller can prove a selection
                // reached the app-server rather than only the settings list.
                text:
                    `Scripted Codex answer (${String(readParam("model"))}/${String(readParam("effort"))}` +
                    `/${String(readParam("approvalPolicy"))}/${String(readParam("serviceTier"))})`,
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
