import { randomUUID } from "node:crypto";
import { link, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeRuntimeUpgradeVersion } from "@moxt-ai/mobius-sdk/protocol";
import { ensurePrivateDirectory } from "../../engine/storage/files/local-files.ts";
import { validateLocalPath } from "../../engine/util/filesystem/private-path.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import type { StateRoot } from "../state-directory.ts";
import { STATE_ROOT_LAYOUT } from "../state-root-layout.ts";

export class CurrentDataError extends Error {
    readonly code = "data_inheritance_failed";
}

// Retain the version-only pointer format for installed CLIs. Its value identifies
// the shared data directory, independently of the executable version using it.
async function readCurrentDataVersion(root: StateRoot, signal: AbortSignal): Promise<string | null> {
    const pointer = join(root, STATE_ROOT_LAYOUT.currentData);
    try {
        await validateLocalPath(pointer, false, true, signal);
        const value = (await readFile(pointer, { encoding: "utf8", signal })).trim();
        if (!value.startsWith("versions/")) {
            throw new CurrentDataError("The current data pointer must name a version directory");
        }
        return decodeRuntimeUpgradeVersion(value.slice("versions/".length));
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return null;
        }
        throw cause;
    }
}

async function prepareDirectory(directory: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await ensurePrivateDirectory(directory);
    await validateLocalPath(directory, true, true, signal);
}

/** Resolve the one data directory used by both commands and daemons before either writes to it. */
export async function prepareCurrentDataDirectory(
    root: StateRoot,
    initialVersion: string,
    signal: AbortSignal,
): Promise<string> {
    try {
        await prepareDirectory(root, signal);
        const versions = join(root, STATE_ROOT_LAYOUT.versions);
        await prepareDirectory(versions, signal);
        let current = await readCurrentDataVersion(root, signal);
        if (current === null) {
            const candidate = decodeRuntimeUpgradeVersion(initialVersion);
            await prepareDirectory(join(versions, candidate), signal);
            const temporary = join(root, `.current-data-${randomUUID()}.txt`);
            try {
                await writeFile(temporary, `versions/${candidate}\n`, { mode: 0o600, flag: "wx", signal });
                signal.throwIfAborted();
                try {
                    // Publish a complete pointer without replacing a concurrent first writer.
                    await link(temporary, join(root, STATE_ROOT_LAYOUT.currentData));
                } catch (cause) {
                    if (!isNodeError(cause, "EEXIST")) {
                        throw cause;
                    }
                }
            } finally {
                await rm(temporary, { force: true });
            }
            current = await readCurrentDataVersion(root, signal);
            if (current === null) {
                throw new CurrentDataError("The current data pointer disappeared during initialization");
            }
        }
        const directory = join(versions, current);
        await prepareDirectory(directory, signal);
        return directory;
    } catch (cause) {
        signal.throwIfAborted();
        throw new CurrentDataError("The current data directory cannot be initialized", { cause });
    }
}

/** Existing data containers only; never traverse workspaces or follow symbolic links. */
export async function listVersionDataDirectories(root: StateRoot, signal: AbortSignal): Promise<readonly string[]> {
    const versions = join(root, STATE_ROOT_LAYOUT.versions);
    await validateLocalPath(root, true, true, signal);
    await validateLocalPath(versions, true, true, signal);
    const directories: string[] = [];
    for (const entry of await readdir(versions, { withFileTypes: true })) {
        signal.throwIfAborted();
        if (!entry.isDirectory()) {
            continue;
        }
        const directory = join(versions, entry.name);
        await validateLocalPath(directory, true, true, signal);
        directories.push(directory);
    }
    return directories;
}
