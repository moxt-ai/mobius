import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeUpgradeVersionSchema } from "@moxt-ai/mobius-sdk/protocol";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import { isNodeError } from "../../util/node-error.ts";

// Each daemon version keeps its data in `versions/<version>/` under the state root, and
// `current-data.txt` names the version whose data is current.

export class DataInheritanceError extends Error {
    readonly code = "data_inheritance_failed";
}

/** The version the current data pointer names, or null when there is no pointer. */
export async function readCurrentDataVersion(root: string, signal: AbortSignal): Promise<string | null> {
    // A relative, version-only pointer remains valid if the state root is moved.
    const pointer = join(root, "current-data.txt");
    try {
        await validateLocalPath(pointer, false, true, signal);
        const value = (await readFile(pointer, { encoding: "utf8", signal })).trim();
        if (!value.startsWith("versions/")) {
            throw new DataInheritanceError("The current data pointer must name a version directory");
        }
        return runtimeUpgradeVersionSchema.parse(value.slice("versions/".length));
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return null;
        }
        throw cause;
    }
}

export async function versionDataExists(root: string, version: string, signal: AbortSignal): Promise<boolean> {
    try {
        await validateLocalPath(join(root, "versions", version), true, true, signal);
        return true;
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
        return false;
    }
}

/** Copies one version's data into a new version's directory. Symbolic links are rejected. */
export async function copyVersionData(
    root: string,
    sourceVersion: string,
    targetVersion: string,
    signal: AbortSignal,
): Promise<void> {
    const versions = join(root, "versions");
    const source = join(versions, sourceVersion);
    const target = join(versions, targetVersion);
    await validateLocalPath(root, true, true, signal);
    await validateLocalPath(versions, true, true, signal);
    await validateLocalPath(source, true, true, signal);
    const staging = await mkdtemp(join(versions, `.${targetVersion}-`));
    try {
        await cp(source, staging, {
            recursive: true,
            filter: async (path) => {
                signal.throwIfAborted();
                if ((await lstat(path)).isSymbolicLink()) {
                    throw new DataInheritanceError("The inherited data contains a symbolic link");
                }
                return true;
            },
        });
        signal.throwIfAborted();
        try {
            await rename(staging, target);
        } catch (cause) {
            // Another CLI may have finished the same first-use copy.
            if (!isNodeError(cause, "EEXIST") && !isNodeError(cause, "ENOTEMPTY")) {
                throw cause;
            }
            await validateLocalPath(target, true, true, signal);
        }
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

/** Points the current data pointer at a version whose data directory exists. */
export async function writeCurrentDataVersion(root: string, version: string, signal: AbortSignal): Promise<void> {
    await validateLocalPath(root, true, true, signal);
    await validateLocalPath(join(root, "versions", version), true, true, signal);
    const temporary = join(root, `.current-data-${randomUUID()}.txt`);
    try {
        await writeFile(temporary, `versions/${version}\n`, { mode: 0o600, flag: "wx", signal });
        signal.throwIfAborted();
        await rename(temporary, join(root, "current-data.txt"));
    } finally {
        await rm(temporary, { force: true });
    }
}
