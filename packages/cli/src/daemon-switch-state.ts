import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { workerLaunch } from "./daemon-lifecycle-protocol.ts";
import { isNodeError } from "./daemon-local-control.ts";

const transition = { id: z.string().min(1).max(256), previous: workerLaunch, next: workerLaunch };
export const daemonSwitchState = z
    .discriminatedUnion("kind", [
        z.object({ ...transition, kind: z.literal("switching") }),
        z.object({ ...transition, kind: z.literal("switched") }),
        z.object({
            ...transition,
            kind: z.literal("rolled-back"),
            code: z.string(),
            message: z.string(),
            retryAfter: z.number().int().nonnegative(),
        }),
    ])
    .readonly();
export type DaemonSwitchState = z.infer<typeof daemonSwitchState>;

export async function readSwitchState(directory: string): Promise<DaemonSwitchState | null> {
    try {
        return daemonSwitchState.parse(JSON.parse(await readFile(join(directory, "worker-switch.json"), "utf8")));
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return null;
        }
        throw cause;
    }
}

export async function writePrivateJson(directory: string, name: string, value: unknown): Promise<void> {
    const staging = join(directory, `.${name}.${randomUUID()}`);
    try {
        await writeFile(staging, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        await rename(staging, join(directory, name));
    } finally {
        await rm(staging, { force: true });
    }
}

export async function writeSwitchState(directory: string, state: DaemonSwitchState): Promise<void> {
    await writePrivateJson(directory, "worker-switch.json", daemonSwitchState.parse(state));
}

export async function waitForSwitchResult(directory: string, signal: AbortSignal): Promise<DaemonSwitchState | null> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(130_000)]);
    deadline.throwIfAborted();
    return await new Promise((resolve, reject) => {
        const watcher = watch(directory, () => {
            void check();
        });
        const cleanup = (): void => {
            watcher.close();
            deadline.removeEventListener("abort", abort);
        };
        const abort = (): void => {
            cleanup();
            reject(deadline.reason);
        };
        const check = async (): Promise<void> => {
            try {
                const state = await readSwitchState(directory);
                if (state?.kind !== "switching") {
                    cleanup();
                    resolve(state);
                }
            } catch (cause) {
                cleanup();
                reject(cause);
            }
        };
        watcher.once("error", (cause) => {
            cleanup();
            reject(cause);
        });
        deadline.addEventListener("abort", abort, { once: true });
        void check();
    });
}
