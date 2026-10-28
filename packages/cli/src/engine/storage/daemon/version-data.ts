import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { decodeRuntimeUpgradeVersion } from "@moxt-ai/mobius-sdk/protocol";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import { isNodeError } from "../../util/node-error.ts";
import type { StateRoot } from "../state-directory.ts";
import { STATE_ROOT_ENTRY_NAMES, STATE_ROOT_LAYOUT } from "../state-root-layout.ts";

// Each daemon version keeps its data in `versions/<version>/` under the state root, and
// `current-data.txt` names the version whose data is current.

export class DataInheritanceError extends Error {
    readonly code = "data_inheritance_failed";
}

/** The version the current data pointer names, or null when there is no pointer. */
export async function readCurrentDataVersion(root: StateRoot, signal: AbortSignal): Promise<string | null> {
    // A relative, version-only pointer remains valid if the state root is moved.
    const pointer = join(root, STATE_ROOT_LAYOUT.currentData);
    try {
        await validateLocalPath(pointer, false, true, signal);
        const value = (await readFile(pointer, { encoding: "utf8", signal })).trim();
        if (!value.startsWith("versions/")) {
            throw new DataInheritanceError("The current data pointer must name a version directory");
        }
        return decodeRuntimeUpgradeVersion(value.slice("versions/".length));
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return null;
        }
        throw cause;
    }
}

export async function versionDataExists(root: StateRoot, version: string, signal: AbortSignal): Promise<boolean> {
    try {
        await validateLocalPath(join(root, STATE_ROOT_LAYOUT.versions, version), true, true, signal);
        return true;
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
        return false;
    }
}

/**
 * Whether a path in a version's data is a state root entry inside an installation, as `installations/<application>/
 * <installation>/npm`. An earlier Mobius that ran with that installation as its root left it; it is not the
 * installation's data, and its release links would otherwise block every later version from starting.
 */
function nestedRootEntry(segments: readonly string[]): boolean {
    return (
        segments.length >= 4 &&
        segments[0] === STATE_ROOT_LAYOUT.installations &&
        STATE_ROOT_ENTRY_NAMES.has(segments[3] ?? "")
    );
}

/**
 * Copies one version's data into a new version's directory and returns the nested state root entries it left
 * behind. Any other symbolic link is rejected.
 */
export async function copyVersionData(
    root: StateRoot,
    sourceVersion: string,
    targetVersion: string,
    signal: AbortSignal,
): Promise<readonly string[]> {
    const leftBehind: string[] = [];
    const versions = join(root, STATE_ROOT_LAYOUT.versions);
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
                const segments = relative(source, path).split(sep);
                if (nestedRootEntry(segments)) {
                    if (segments.length === 4) {
                        leftBehind.push(segments.join("/"));
                    }
                    return false;
                }
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
        return leftBehind;
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

/**
 * Removes a version's data unless the current data pointer names it. The directory leaves in one rename, so a
 * concurrent first use either finds it whole or inherits the current data.
 */
export async function discardVersionData(root: StateRoot, version: string, signal: AbortSignal): Promise<void> {
    if ((await readCurrentDataVersion(root, signal)) === version || !(await versionDataExists(root, version, signal))) {
        return;
    }
    const versions = join(root, STATE_ROOT_LAYOUT.versions);
    const discarded = join(versions, `.${version}-discarded-${randomUUID()}`);
    try {
        await rename(join(versions, version), discarded);
    } catch (cause) {
        // Another process already discarded it.
        if (isNodeError(cause, "ENOENT")) {
            return;
        }
        throw cause;
    }
    await rm(discarded, { recursive: true, force: true });
}

/** Points the current data pointer at a version whose data directory exists. */
export async function writeCurrentDataVersion(root: StateRoot, version: string, signal: AbortSignal): Promise<void> {
    await validateLocalPath(root, true, true, signal);
    await validateLocalPath(join(root, STATE_ROOT_LAYOUT.versions, version), true, true, signal);
    const temporary = join(root, `.current-data-${randomUUID()}.txt`);
    try {
        await writeFile(temporary, `versions/${version}\n`, { mode: 0o600, flag: "wx", signal });
        signal.throwIfAborted();
        await rename(temporary, join(root, STATE_ROOT_LAYOUT.currentData));
    } finally {
        await rm(temporary, { force: true });
    }
}
