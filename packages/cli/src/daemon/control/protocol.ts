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

const lifecycleCommandKinds = new Set(["ensure", "status", "stop", "switch", "switch-status"]);
const lifecycleResponseKinds = new Set(["error", "status", "stopped", "switching", "switch-status"]);
const daemonSwitchStateKinds = new Set(["rolled-back", "switched", "switching"]);

function hasUnknownKind(value: unknown, known: ReadonlySet<string>): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        typeof value.kind === "string" &&
        !known.has(value.kind)
    );
}

export const decodeKnownLifecycleCommand = (value: unknown): z.infer<typeof lifecycleCommand> | null =>
    hasUnknownKind(value, lifecycleCommandKinds) ? null : lifecycleCommand.parse(value);

export const decodeKnownLifecycleResponse = (value: unknown): LifecycleResponse | null => {
    if (hasUnknownKind(value, lifecycleResponseKinds)) {
        return null;
    }
    if (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "switch-status" &&
        "state" in value &&
        hasUnknownKind(value.state, daemonSwitchStateKinds)
    ) {
        return lifecycleResponse.parse({ ...value, state: null });
    }
    return lifecycleResponse.parse(value);
};
