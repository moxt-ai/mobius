import { dirname, join } from "node:path";
import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import {
    channelIndexFilePath,
    connectionFilePath,
    readInstallationFile,
    removeInstallationFile,
} from "../../engine/storage/installation/installation-files.ts";
import { validateLocalPath } from "../../engine/util/filesystem/private-path.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import type { StateRoot } from "../state-directory.ts";
import { CurrentDataError, listVersionDataDirectories } from "./current-data.ts";

/** Remove only this pairing's files from snapshots left by releases that copied data. */
export async function removeHistoricalPairingFiles(
    root: StateRoot,
    currentInstallation: string,
    installationId: string,
    connectionId: string,
    channelId: string,
    signal: AbortSignal,
): Promise<void> {
    if (![installationId, connectionId, channelId].every(isIdentifier)) {
        throw new CurrentDataError("Invalid pairing identity");
    }
    for (const data of await listVersionDataDirectories(root, signal)) {
        const installation = join(data, "installations", "dev.mobius.cli", installationId);
        if (installation === currentInstallation) {
            continue;
        }
        try {
            // Validate each parent before accessing children; a historical workspace
            // or symlink must never become a target of credential cleanup.
            await validateLocalPath(join(data, "installations"), true, true, signal);
            await validateLocalPath(join(data, "installations", "dev.mobius.cli"), true, true, signal);
            await validateLocalPath(installation, true, true, signal);
        } catch (cause) {
            if (isNodeError(cause, "ENOENT")) {
                continue;
            }
            throw cause;
        }
        await removeSavedFile(connectionFilePath(join(installation, "connections"), connectionId), signal);
        const indexPath = channelIndexFilePath(installation, channelId);
        try {
            await validateLocalPath(dirname(indexPath), true, true, signal);
            await validateLocalPath(indexPath, false, true, signal);
        } catch (cause) {
            if (isNodeError(cause, "ENOENT")) {
                continue;
            }
            throw cause;
        }
        const stored = await readInstallationFile(indexPath);
        if (stored.kind === "read") {
            const index: unknown = JSON.parse(stored.text);
            if (
                typeof index === "object" &&
                index !== null &&
                "connectionId" in index &&
                index.connectionId === connectionId
            ) {
                await removeSavedFile(indexPath, signal);
            }
        }
    }
}

async function removeSavedFile(path: string, signal: AbortSignal): Promise<void> {
    try {
        await validateLocalPath(dirname(path), true, true, signal);
        signal.throwIfAborted();
        await removeInstallationFile(path);
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
    }
}
