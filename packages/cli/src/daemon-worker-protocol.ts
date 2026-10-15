import { z } from "zod";

const connectionId = z.string().regex(/^mcn_[a-f0-9]{32}$/);
const argumentsSchema = z.array(z.string().max(4096)).max(16).readonly();
const runtime = z
    .object({
        appId: z.string(),
        connectionId,
        runtimeId: z.string(),
        workspace: z.string(),
        status: z.enum(["starting", "online", "reconnecting", "failed", "stopped"]),
    })
    .readonly();

export const workerCommand = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("list") }),
        z.object({ kind: z.literal("pair"), arguments: argumentsSchema }),
        z.object({ kind: z.literal("start"), arguments: argumentsSchema }),
        z.object({ kind: z.literal("remove-pair"), connectionId }),
        z.object({ kind: z.literal("stop-pair"), connectionId }),
    ])
    .readonly();

export const workerResponse = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("error"), code: z.string(), message: z.string() }),
        z.object({ kind: z.literal("listed"), pairs: z.array(runtime).readonly() }),
        z.object({ kind: z.literal("pair-removed"), connectionId }),
        z.object({ kind: z.literal("pair-stopped"), pair: runtime }),
        z.object({ kind: z.literal("ready"), alreadyOnline: z.boolean(), pair: runtime }),
    ])
    .readonly();

export type WorkerCommand = z.infer<typeof workerCommand>;
export type WorkerResponse = z.infer<typeof workerResponse>;
export type ManagedRuntimeSummary = z.infer<typeof runtime>;
export type ManagedRuntimeStatus = ManagedRuntimeSummary["status"];
