import { runtimeUpgradeVersionSchema } from "@moxt-ai/mobius-sdk/protocol";
import {
    copyVersionData,
    discardVersionData,
    readCurrentDataVersion,
    versionDataExists,
    writeCurrentDataVersion,
} from "../../storage/daemon/version-data.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";
import { readSwitchStatus } from "../control/switch-status.ts";

// A version that has never run inherits the current data, or the data of the version it replaces.
export async function prepareVersionData(
    version: string,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    fallbackVersion: string | null = null,
): Promise<void> {
    signal.throwIfAborted();
    const root = readStateDirectory(environment);
    const targetVersion = runtimeUpgradeVersionSchema.parse(version);
    if (await versionDataExists(root, targetVersion, signal)) {
        return;
    }
    const previous = (await readCurrentDataVersion(root, signal)) ?? fallbackVersion;
    if (previous === null) {
        return;
    }
    const leftBehind = await copyVersionData(root, runtimeUpgradeVersionSchema.parse(previous), targetVersion, signal);
    for (const entry of leftBehind) {
        process.stderr.write(
            `Mobius did not carry ${entry} into version ${targetVersion}: an earlier Mobius ran with that installation as its state root.\n`,
        );
    }
}

// A version whose switch rolled back never had the current data; once the previous version runs again, its copy is
// stale, and its next attempt must inherit the current data rather than reuse that copy.
export async function discardRolledBackData(version: string, signal: AbortSignal): Promise<void> {
    await discardVersionData(readStateDirectory(), runtimeUpgradeVersionSchema.parse(version), signal);
}

export async function recordCurrentData(version: string, signal: AbortSignal): Promise<void> {
    await writeCurrentDataVersion(readStateDirectory(), runtimeUpgradeVersionSchema.parse(version), signal);
}

export async function prepareUpgradeData(
    controlDirectory: string,
    version: string,
    signal: AbortSignal,
): Promise<void> {
    const transition = await readSwitchStatus(controlDirectory, signal);
    const previous =
        transition?.kind === "switching" && transition.next.version === version ? transition.previous.version : null;
    await prepareVersionData(version, signal, process.env, previous);
}
