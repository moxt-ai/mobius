import { cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { runtimeUpgradeVersionSchema } from "@moxt-ai/mobius-protocol";
import { isNodeError } from "./daemon-local-control.ts";
import { readSwitchStatus } from "./daemon-switch-status.ts";
import { readStateDirectory } from "./storage/state-directory.ts";

export async function prepareUpgradeData(version: string, signal: AbortSignal): Promise<void> {
    const transition = await readSwitchStatus(signal);
    if (transition?.kind !== "switching" || transition.next.version !== version) {
        return;
    }
    const previousVersion = runtimeUpgradeVersionSchema.parse(transition.previous.version);
    const targetVersion = runtimeUpgradeVersionSchema.parse(version);
    const versions = join(readStateDirectory(), "versions");
    const target = join(versions, targetVersion);
    try {
        await stat(target);
        return;
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
    }
    signal.throwIfAborted();
    await mkdir(versions, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(versions, `.${targetVersion}-`));
    try {
        await cp(join(versions, previousVersion), staging, {
            recursive: true,
            filter: () => {
                signal.throwIfAborted();
                return true;
            },
        });
        signal.throwIfAborted();
        await rename(staging, target);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}
