import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// A scripted Codex app-server for discovery-time coverage of the in-process Agent. It answers the
// `turn/start` lifecycle Mobius drives so discovery can prove the whole handshake without the real
// binary. It is a fixture for the vendor protocol, not a second ACP Agent.
const input = createInterface({ input: process.stdin });
let initialized = false;
let nextThread = 0;
let nextTurn = 0;
// A thread becomes resumable only once it has run a turn, which is how the real app-server
// behaves, so the fixture tracks what each thread has done rather than assuming every one works.
interface KnownThread {
    archived: boolean;
    collaborationMode: string;
    cwd: string;
    effort: string;
    id: string;
    model: string;
    preview: string;
    prompted: boolean;
}

// The real app-server persists threads, and Mobius browses them through a second app-server
// process. Keeping this on disk is what lets listing and resume work across processes.
const stateDirectory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
const readerPath = stateDirectory === undefined ? null : join(stateDirectory, `${process.pid.toString()}.reader`);

function threadPath(threadId: string): string | null {
    return stateDirectory === undefined ? null : join(stateDirectory, `thread-${encodeURIComponent(threadId)}.json`);
}

function readThread(threadId: string): KnownThread | undefined {
    const path = threadPath(threadId);
    if (path === null || !existsSync(path)) {
        return undefined;
    }
    try {
        return JSON.parse(readFileSync(path, "utf8")) as KnownThread;
    } catch {
        return undefined;
    }
}

function writeThread(thread: KnownThread): void {
    const path = threadPath(thread.id);
    if (path !== null) {
        writeFileSync(path, `${JSON.stringify(thread)}\n`, { mode: 0o600 });
    }
}

function allThreads(): readonly KnownThread[] {
    if (stateDirectory === undefined || !existsSync(stateDirectory)) {
        return [];
    }
    const threads: KnownThread[] = [];
    for (const entry of readdirSync(stateDirectory)) {
        if (!entry.startsWith("thread-") || !entry.endsWith(".json")) {
            continue;
        }
        const id = decodeURIComponent(entry.slice("thread-".length, -".json".length));
        const thread = readThread(id);
        if (thread !== undefined) {
            threads.push(thread);
        }
    }
    return threads;
}

process.on("exit", () => {
    if (readerPath !== null && existsSync(readerPath)) {
        unlinkSync(readerPath);
    }
});
let activeTurnId: string | null = null;
const steeredPrompts: unknown[] = [];

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
        if (process.env["MOBIUS_FAKE_CODEX_EXIT_DURING_MODEL_LIST"] === "1") {
            process.exit(73);
        }
        reply(id, { data: MODELS, nextCursor: null });
        return;
    }
    if (method === "thread/start") {
        nextThread += 1;
        const cwdValue = readParam("cwd");
        const threadId = `thread-${process.pid.toString()}-${nextThread.toString()}`;
        writeThread({
            archived: false,
            collaborationMode: "default",
            cwd: typeof cwdValue === "string" ? cwdValue : "",
            effort: "medium",
            id: threadId,
            model: "scripted-small",
            preview: "",
            prompted: false,
        });
        // A real app-server reports the model and effort it resolved from Codex's own configuration;
        // Mobius reads them back as the current settings values.
        reply(id, {
            model:
                process.env["MOBIUS_FAKE_CODEX_REPORT_UNAVAILABLE_MODEL"] === "1"
                    ? "unavailable-model"
                    : "scripted-small",
            reasoningEffort: "medium",
            thread: { cwd: readParam("cwd"), id: threadId },
        });
        return;
    }
    if (method === "thread/settings/update") {
        const threadId = readParam("threadId");
        const collaborationMode = readParam("collaborationMode");
        const mode =
            typeof collaborationMode === "object" && collaborationMode !== null
                ? Reflect.get(collaborationMode, "mode")
                : undefined;
        const thread = typeof threadId === "string" ? readThread(threadId) : undefined;
        if (typeof threadId !== "string" || (mode !== undefined && mode !== "default" && mode !== "plan")) {
            process.stdout.write(
                `${JSON.stringify({ id, error: { code: -32602, message: "Invalid collaboration mode" } })}\n`,
            );
            return;
        }
        if (thread !== undefined && mode !== undefined) {
            writeThread({ ...thread, collaborationMode: mode });
        }
        reply(id, {});
        return;
    }
    if (method === "turn/start") {
        if (
            process.env["MOBIUS_FAKE_CODEX_REPORT_UNAVAILABLE_MODEL"] === "1" &&
            !MODELS.some((model) => model.id === readParam("model"))
        ) {
            process.stdout.write(`${JSON.stringify({ id, error: { code: -32602, message: "Model unavailable" } })}\n`);
            return;
        }
        nextTurn += 1;
        const threadId = readParam("threadId");
        const turnId = `turn-${nextTurn.toString()}`;
        activeTurnId = turnId;
        const thread = typeof threadId === "string" ? readThread(threadId) : undefined;
        const collaborationMode = readParam("collaborationMode");
        const requestedCollaborationMode =
            typeof collaborationMode === "object" && collaborationMode !== null
                ? Reflect.get(collaborationMode, "mode")
                : undefined;
        const activeCollaborationMode =
            requestedCollaborationMode === "default" || requestedCollaborationMode === "plan"
                ? requestedCollaborationMode
                : (thread?.collaborationMode ?? "default");
        if (thread !== undefined) {
            writeThread({
                ...thread,
                collaborationMode: activeCollaborationMode ?? thread.collaborationMode,
                preview: "Scripted turn",
                prompted: true,
            });
        }
        const promptInput = readParam("input");
        const promptText = Array.isArray(promptInput)
            ? promptInput
                  .flatMap((part: unknown) => {
                      if (typeof part !== "object" || part === null || Reflect.get(part, "type") !== "text") {
                          return [];
                      }
                      const text = Reflect.get(part, "text");
                      return typeof text === "string" ? [text] : [];
                  })
                  .join("\n")
            : "";
        if (promptText === "fixture: exit before turn acknowledgement") {
            process.exit(71);
        }
        reply(id, {
            turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress" },
        });
        if (promptText === "fixture: exit after turn acknowledgement") {
            process.stdout.write("", () => process.exit(72));
            return;
        }
        if (promptText === "fixture: invalid frame after turn acknowledgement") {
            process.stdout.write("{invalid app-server frame\n");
            return;
        }
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
        if (promptText === "fixture: wait for cancellation") {
            return;
        }
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
                    `/${String(readParam("approvalPolicy"))}/${String(readParam("serviceTier"))}` +
                    `/${String(activeCollaborationMode)})`,
                type: "agentMessage",
            },
            threadId,
            turnId,
        });
        notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "completed" } });
        activeTurnId = null;
        return;
    }
    if (method === "turn/interrupt") {
        const threadId = readParam("threadId");
        const turnId = readParam("turnId");
        reply(id, {});
        notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "interrupted" } });
        activeTurnId = null;
        return;
    }
    if (method === "thread/list") {
        const threads = allThreads().filter((thread) => !thread.archived);
        reply(id, {
            data: threads.map((thread) => ({
                createdAt: 1_700_000_000,
                cwd: thread.cwd,
                id: thread.id,
                name: null,
                preview: thread.preview,
                updatedAt: 1_700_000_100,
            })),
            nextCursor: null,
        });
        return;
    }
    if (method === "thread/resume") {
        const threadId = readParam("threadId");
        const thread = typeof threadId === "string" ? readThread(threadId) : undefined;
        if (thread === undefined) {
            process.stdout.write(
                `${JSON.stringify({ id, error: { code: -32600, message: `no rollout found for thread id ${String(threadId)}` } })}\n`,
            );
            return;
        }
        // A thread with no turns yet answers with an empty body, which is what a real app-server
        // does; Mobius has to treat that as "cannot restore" rather than "restored".
        if (thread.prompted !== true) {
            reply(id, {});
            return;
        }
        if (thread.archived) {
            process.stdout.write(
                `${JSON.stringify({ id, error: { code: -32600, message: `session ${thread.id} is archived` } })}\n`,
            );
            return;
        }
        reply(id, { model: thread.model, reasoningEffort: thread.effort, thread: { id: thread.id } });
        return;
    }
    if (method === "thread/archive") {
        const threadId = readParam("threadId");
        const thread = typeof threadId === "string" ? readThread(threadId) : undefined;
        if (thread !== undefined) {
            // Archiving hides the thread but keeps it resumable for a non-archived check, matching
            // how the real app-server refuses to reopen an archived thread rather than losing it.
            writeThread({ ...thread, archived: true });
        }
        reply(id, {});
        return;
    }
    if (method === "turn/steer") {
        const threadId = readParam("threadId");
        const expectedTurnId = readParam("expectedTurnId");
        // Steering is only accepted while the named turn is the one actually running.
        if (expectedTurnId !== activeTurnId) {
            process.stdout.write(
                `${JSON.stringify({ id, error: { code: -32600, message: `expected active turn id \`${String(expectedTurnId)}\` but found \`${String(activeTurnId)}\`` } })}\n`,
            );
            return;
        }
        steeredPrompts.push(readParam("input"));
        reply(id, { turnId: String(expectedTurnId) });
        void threadId;
        return;
    }
    process.stdout.write(`${JSON.stringify({ id, error: { code: -32601, message: "Unsupported method" } })}\n`);
});
