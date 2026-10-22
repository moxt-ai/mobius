import { runtimeUpgradeVersionSchema } from "@moxt-ai/mobius-sdk/protocol";
import {
    copyVersionData,
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
    await copyVersionData(root, runtimeUpgradeVersionSchema.parse(previous), targetVersion, signal);
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
