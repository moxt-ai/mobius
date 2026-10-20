import { z } from "zod";

export const workerLaunch = z
    .object({
        executable: z.string().min(1),
        entry: z.string().min(1),
        version: z.string().min(1).max(128),
    })
    .readonly();
export type WorkerLaunch = z.infer<typeof workerLaunch>;

const transition = {
    id: z.string().min(1).max(256),
    context: z.string().max(256),
    previous: workerLaunch,
    next: workerLaunch,
};
export const daemonSwitchState = z
    .discriminatedUnion("kind", [
        z.object({ ...transition, kind: z.literal("switching") }),
        z.object({ ...transition, kind: z.literal("switched") }),
        z.object({
            ...transition,
            kind: z.literal("rolled-back"),
            code: z.string(),
            message: z.string(),
            stdout: z.string().max(4096),
            stderr: z.string().max(4096),
            retryAfter: z.number().int().nonnegative(),
        }),
    ])
    .readonly();
export type DaemonReleaseSwitchState = z.infer<typeof daemonSwitchState>;

export const lifecycleCommand = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("status") }),
        z.object({ kind: z.literal("ensure"), launch: workerLaunch }),
        z.object({ kind: z.literal("stop") }),
        z.object({
            kind: z.literal("switch"),
            id: z.string().min(1).max(256),
            context: z.string().max(256),
            launch: workerLaunch,
        }),
        z.object({ kind: z.literal("switch-status"), wait: z.boolean() }),
    ])
    .readonly();
export const lifecycleResponse = z
    .discriminatedUnion("kind", [
        z.object({
            kind: z.literal("status"),
            protocolVersion: z.literal(2),
            worker: z.object({ pid: z.number().int().positive(), version: z.string() }).readonly().nullable(),
        }),
        z.object({ kind: z.literal("switch-status"), state: daemonSwitchState.nullable() }),
        z.object({ kind: z.literal("stopped") }),
        z.object({ kind: z.literal("switching") }),
        z.object({ kind: z.literal("error"), code: z.string(), message: z.string() }),
    ])
    .readonly();
export type LifecycleResponse = z.infer<typeof lifecycleResponse>;
