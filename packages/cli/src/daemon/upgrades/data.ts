import { decodeRuntimeUpgradeVersion } from "@moxt-ai/mobius-sdk/protocol";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import {
    copyVersionData,
    discardVersionData,
    readCurrentDataVersion,
    versionDataExists,
    writeCurrentDataVersion,
} from "../../storage/daemon/version-data.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";
import { readSwitchStatus } from "../control/switch-status.ts";

// A version whose data is not current inherits the current data. Without a current data pointer, a version that has
// never run inherits the data of the version it replaces.
export async function prepareVersionData(
    version: string,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    fallbackVersion: string | null = null,
): Promise<void> {
    signal.throwIfAborted();
    const root = readStateDirectory(environment);
    const targetVersion = decodeRuntimeUpgradeVersion(version);
    const current = await readCurrentDataVersion(root, signal);
    let previous: string;
    if (current !== null) {
        if (current === targetVersion) {
            return;
        }
        // The pointer names the data that wins. A directory it does not name never became current, as one an earlier
        // CLI started for its own version, so it is stale and must not replace the current data.
        await discardVersionData(root, targetVersion, signal);
        previous = current;
    } else {
        if (fallbackVersion === null || (await versionDataExists(root, targetVersion, signal))) {
            return;
        }
        previous = fallbackVersion;
    }
    const leftBehind = await copyVersionData(root, decodeRuntimeUpgradeVersion(previous), targetVersion, signal);
    for (const entry of leftBehind) {
        process.stderr.write(
            `Mobius did not carry ${entry} into version ${targetVersion}: an earlier Mobius ran with that installation as its state root.\n`,
        );
    }
}

// A version whose switch rolled back never had the current data; once the previous version runs again, its copy is
// stale, and its next attempt must inherit the current data rather than reuse that copy.
export async function discardRolledBackData(version: string, signal: AbortSignal): Promise<void> {
    await discardVersionData(readStateDirectory(), decodeRuntimeUpgradeVersion(version), signal);
}

export async function recordCurrentData(version: string, signal: AbortSignal): Promise<void> {
    await writeCurrentDataVersion(readStateDirectory(), decodeRuntimeUpgradeVersion(version), signal);
}

export async function prepareUpgradeData(
    controlDirectory: InstallationDirectory,
    version: string,
    signal: AbortSignal,
): Promise<void> {
    const transition = await readSwitchStatus(controlDirectory, signal);
    const previous =
        transition?.kind === "switching" && transition.next.version === version ? transition.previous.version : null;
    await prepareVersionData(version, signal, process.env, previous);
}
