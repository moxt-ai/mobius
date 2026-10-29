import { readFileSync } from "node:fs";
import { RequestError } from "@agentclientprotocol/sdk";
import { z } from "zod";

const entrySchema = z
    .object({
        type: z.string(),
        id: z.string(),
        parentId: z.string().nullable(),
    })
    .passthrough();

const messageSchema = z
    .object({
        role: z.enum(["user", "assistant", "toolResult"]),
        content: z.unknown(),
    })
    .passthrough();

export type PiHistoryEntry =
    | { readonly type: "message"; readonly message: z.infer<typeof messageSchema> }
    | { readonly type: "compaction"; readonly id: string; readonly summary: string };

/** Follow the native display branch, not the compacted model-context projection. */
export function readPiHistory(sessionFile: string): readonly PiHistoryEntry[] {
    try {
        const entries = new Map<string, z.infer<typeof entrySchema>>();
        let leaf: string | null = null;
        for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/u)) {
            if (!line.trim()) {
                continue;
            }
            const value: unknown = JSON.parse(line);
            if (z.object({ type: z.literal("session") }).safeParse(value).success) {
                continue;
            }
            const entry = entrySchema.parse(value);
            entries.set(entry.id, entry);
            leaf = entry.id;
        }
        const history: PiHistoryEntry[] = [];
        const visited = new Set<string>();
        while (leaf !== null) {
            const entry = entries.get(leaf);
            if (entry === undefined || visited.has(leaf)) {
                throw new Error("Invalid Pi history branch");
            }
            visited.add(leaf);
            if (entry.type === "message") {
                const { role } = z.object({ role: z.string() }).parse(entry.message);
                // Native-only roles such as bashExecution have no chat content.
                // Match RPC replay's supported roles without rejecting their neighbours.
                if (role === "user" || role === "assistant" || role === "toolResult") {
                    history.push({ type: "message", message: messageSchema.parse(entry.message) });
                }
            } else if (entry.type === "compaction") {
                history.push({ type: "compaction", id: entry.id, summary: z.string().parse(entry.summary) });
            }
            leaf = entry.parentId;
        }
        return history.reverse();
    } catch (cause: unknown) {
        const error = RequestError.internalError({ code: "PI_HISTORY_READ_FAILED" }, "Unable to read Pi history");
        error.cause = cause;
        throw error;
    }
}
