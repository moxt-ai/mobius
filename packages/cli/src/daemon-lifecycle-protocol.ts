import { z } from "zod";

export const workerLaunch = z
    .object({
        executable: z.string().min(1),
        entry: z.string().min(1),
        version: z.string().min(1).max(128),
    })
    .readonly();
export type WorkerLaunch = z.infer<typeof workerLaunch>;

export const lifecycleCommand = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("status") }),
        z.object({ kind: z.literal("ensure"), launch: workerLaunch }),
        z.object({ kind: z.literal("stop") }),
    ])
    .readonly();
export const lifecycleResponse = z
    .discriminatedUnion("kind", [
        z.object({
            kind: z.literal("status"),
            protocolVersion: z.literal(1),
            worker: z.object({ pid: z.number().int().positive(), version: z.string() }).readonly().nullable(),
        }),
        z.object({ kind: z.literal("stopped") }),
        z.object({ kind: z.literal("error"), code: z.string(), message: z.string() }),
    ])
    .readonly();
export type LifecycleResponse = z.infer<typeof lifecycleResponse>;
