import { decodeRuntimeUpgradeVersion } from "@moxt-ai/mobius-sdk/protocol";
import {
    copyVersionData,
    discardVersionData,
    readCurrentDataVersion,
    writeCurrentDataVersion,
} from "../../storage/daemon/version-data.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";

// A version whose data is not current inherits the current data. Without a current data pointer, nothing has run yet,
// so there is nothing to inherit.
export async function prepareVersionData(version: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const root = readStateDirectory();
    const targetVersion = decodeRuntimeUpgradeVersion(version);
    const current = await readCurrentDataVersion(root, signal);
    if (current === null || current === targetVersion) {
        return;
    }
    // The pointer names the data that wins. A directory it does not name never became current, as one an earlier
    // CLI started for its own version, so it is stale and must not replace the current data.
    await discardVersionData(root, targetVersion, signal);
    await copyVersionData(root, current, targetVersion, signal);
}

export async function recordCurrentData(version: string, signal: AbortSignal): Promise<void> {
    await writeCurrentDataVersion(readStateDirectory(), decodeRuntimeUpgradeVersion(version), signal);
}
