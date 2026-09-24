import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Read the same persisted conversations as the stateful ACP Agent, without
// acquiring its writer. No provider credentials or canned transcripts are used.
const input = createInterface({ input: process.stdin });
const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
const readerPath = directory === undefined ? null : join(directory, `${process.pid.toString()}.reader`);
process.on("exit", () => {
    if (readerPath !== null && existsSync(readerPath)) {
        unlinkSync(readerPath);
    }
});
process.on("SIGTERM", () => process.exit(0));
let initialized = false;
input.on("line", (line) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) {
        return;
    }
    const id: unknown = Reflect.get(value, "id");
    const method: unknown = Reflect.get(value, "method");
    const reply = (result: unknown): void => {
        process.stdout.write(`${JSON.stringify({ id, result })}\n`);
    };
    if (method === "initialize") {
        reply({ userAgent: "stateful-codex" });
    } else if (method === "initialized") {
        initialized = true;
    } else if ((method === "thread/resume" || method === "thread/fork") && initialized) {
        const params: unknown = Reflect.get(value, "params");
        const threadId = typeof params === "object" && params !== null ? Reflect.get(params, "threadId") : undefined;
        if (typeof threadId !== "string" || directory === undefined) {
            return;
        }
        const sourcePath = join(directory, `${encodeURIComponent(threadId)}.json`);
        const saved: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
        if (typeof saved !== "object" || saved === null) {
            return;
        }
        const openedThreadId = method === "thread/fork" ? crypto.randomUUID() : threadId;
        if (method === "thread/fork") {
            writeFileSync(join(directory, `${encodeURIComponent(openedThreadId)}.json`), JSON.stringify(saved));
        }
        reply({
            model: "scripted-small",
            reasoningEffort: "medium",
            thread: { id: openedThreadId },
            turns: [
                {
                    items: [
                        {
                            content: [{ text: Reflect.get(saved, "title"), type: "text" }],
                            id: "prompt",
                            type: "userMessage",
                        },
                        { id: "answer", phase: "final_answer", text: "Restored", type: "agentMessage" },
                    ],
                },
            ],
        });
    } else if (
        (method === "thread/read" || method === "thread/turns/list" || method === "thread/list") &&
        initialized
    ) {
        const params: unknown = Reflect.get(value, "params");
        if (typeof params !== "object" || params === null) {
            return;
        }
        if (method === "thread/list") {
            if (directory === undefined) {
                return;
            }
            const threads = readdirSync(directory)
                .filter((file) => file.endsWith(".json"))
                .toSorted()
                .map((file) => {
                    const saved: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
                    if (typeof saved !== "object" || saved === null) {
                        throw new Error("Invalid saved conversation");
                    }
                    const cwd: unknown = Reflect.get(saved, "cwd");
                    if (typeof cwd !== "string") {
                        throw new Error("Invalid saved conversation cwd");
                    }
                    return {
                        cwd,
                        id: decodeURIComponent(file.slice(0, -5)),
                        name: null,
                        preview: typeof Reflect.get(saved, "title") === "string" ? Reflect.get(saved, "title") : null,
                        updatedAt: Math.floor(statSync(join(directory, file)).mtimeMs / 1000),
                    };
                });
            const cursor: unknown = Reflect.get(params, "cursor");
            const offset = typeof cursor === "string" ? Number(cursor) : 0;
            const limit: unknown = Reflect.get(params, "limit");
            const pageSize = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : threads.length;
            const data = threads.slice(offset, offset + pageSize);
            reply({
                data,
                nextCursor: offset + data.length < threads.length ? String(offset + data.length) : null,
            });
            return;
        }
        const threadId: unknown = Reflect.get(params, "threadId");
        if (typeof threadId !== "string" || directory === undefined) {
            return;
        }
        if (readerPath !== null) {
            writeFileSync(readerPath, threadId);
        }
        // Model an unavailable history store to exercise bounded read cancellation.
        if (existsSync(join(directory, "pause-read"))) {
            return;
        }
        const saved: unknown = JSON.parse(
            readFileSync(join(directory, `${encodeURIComponent(threadId)}.json`), "utf8"),
        );
        if (typeof saved !== "object" || saved === null) {
            return;
        }
        const history: unknown = Reflect.get(saved, "history");
        if (!Array.isArray(history)) {
            return;
        }
        const rich = Reflect.get(params, "itemsView") === "full";
        const turns: { error?: unknown; readonly items: unknown[] }[] = [];
        for (const message of history) {
            if (typeof message !== "object" || message === null) {
                throw new Error("Invalid saved message");
            }
            const text: unknown = Reflect.get(message, "text");
            const images: unknown = Reflect.get(message, "images");
            if (Reflect.get(message, "role") === "user") {
                turns.push({
                    items: [
                        {
                            type: "userMessage",
                            content: [
                                { type: "text", text },
                                ...(Array.isArray(images)
                                    ? images.map((image: unknown) => {
                                          if (typeof image !== "object" || image === null) {
                                              throw new Error("Invalid saved image");
                                          }
                                          const path = Reflect.get(image, "path");
                                          return {
                                              type: "image",
                                              url:
                                                  typeof path === "string" && path.length > 0
                                                      ? path
                                                      : `data:${String(Reflect.get(image, "mimeType"))};base64,${String(Reflect.get(image, "data"))}`,
                                          };
                                      })
                                    : []),
                            ],
                        },
                    ],
                });
            } else {
                if (rich) {
                    turns.at(-1)?.items.push(
                        {
                            type: "reasoning",
                            id: `reasoning-${turns.length.toString()}`,
                            summary: ["Inspecting the workspace"],
                            content: [],
                        },
                        {
                            type: "agentMessage",
                            id: `commentary-${turns.length.toString()}`,
                            text: "I’ll inspect the saved workspace context.",
                            phase: "commentary",
                        },
                        {
                            type: "commandExecution",
                            id: `command-${turns.length.toString()}`,
                            command: "cat package.json",
                            cwd: Reflect.get(saved, "cwd"),
                            status: "completed",
                            commandActions: [],
                            aggregatedOutput: '{"name":"fixture"}',
                            exitCode: 0,
                        },
                    );
                    const turn = turns.at(-1);
                    if (turn !== undefined) {
                        turn.error = { message: "Agent could not inspect the optional workspace file" };
                    }
                }
                turns.at(-1)?.items.push({ type: "agentMessage", text, phase: "final_answer" });
            }
        }
        if (method === "thread/read") {
            reply({
                thread: {
                    id: threadId,
                    cwd: Reflect.get(saved, "cwd"),
                    turns: Reflect.get(params, "includeTurns") === false ? [] : turns,
                },
            });
        } else {
            const limit: unknown = Reflect.get(params, "limit");
            if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
                throw new Error("Invalid page size");
            }
            const cursor: unknown = Reflect.get(params, "cursor");
            const offset = typeof cursor === "string" ? Number(cursor) : 0;
            const ordered = Reflect.get(params, "sortDirection") === "asc" ? turns : turns.toReversed();
            const data = ordered.slice(offset, offset + limit);
            reply({
                data,
                nextCursor: offset + data.length < turns.length ? String(offset + data.length) : null,
            });
        }
    } else {
        process.stdout.write(`${JSON.stringify({ id, error: { code: -32601, message: "Unsupported method" } })}\n`);
    }
});
