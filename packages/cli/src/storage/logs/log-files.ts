import type { Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export {
    DAEMON_LOG_FILENAME,
    logDirectory,
    processLogPaths,
    readLogText,
    unhandledRejectionLogFilename,
    WORKER_LIFECYCLE_LOG_FILENAME,
} from "../../engine/storage/logs/log-files.ts";

const LOG_FILE_NAME_PATTERN = /^[\w.-]{1,128}\.log$/u;
const INSTALLATIONS_DIRECTORY = "installations";
const VERSIONS_DIRECTORY = "versions";

/** True when a path is legitimately absent, rather than present and unreadable. */
function isAbsent(cause: unknown): boolean {
    return typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "ENOENT";
}

/**
 * Resolve the installation log directories. The installation store produces two
 * shapes: `<root>/installations/<appId>/<installationId>` for the control
 * installation, and the same path under `versions/<version>/` for a version-
 * scoped CLI installation. These are enumerated instead of walked, because the
 * state root also holds Agent adapters with their own node_modules trees.
 *
 * Directories that exist but cannot be read are added to `unreadable`, relative to `root`.
 */
export async function findLogDirectories(
    root: string,
    unreadable: string[],
    signal: AbortSignal,
): Promise<readonly string[]> {
    const versions = join(root, VERSIONS_DIRECTORY);
    const installationsRoots: string[] = [join(root, INSTALLATIONS_DIRECTORY)];
    for (const version of await listDirectories(versions, root, unreadable, signal)) {
        installationsRoots.push(join(versions, version, INSTALLATIONS_DIRECTORY));
    }
    const found: string[] = [];
    for (const installations of installationsRoots) {
        for (const dataDirectory of await listDirectories(installations, root, unreadable, signal)) {
            const application = join(installations, dataDirectory);
            for (const installationId of await listDirectories(application, root, unreadable, signal)) {
                const logs = join(application, installationId, "logs");
                const status = await directoryStatus(logs);
                if (status === "listed") {
                    found.push(logs);
                } else if (status === "unreadable") {
                    unreadable.push(relative(root, logs));
                }
            }
        }
    }
    return found;
}

async function listDirectories(
    path: string,
    root: string,
    unreadable: string[],
    signal: AbortSignal,
): Promise<readonly string[]> {
    signal.throwIfAborted();
    try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
    } catch (cause) {
        // A state root that has never been used has no installations directory;
        // anything else is a failure to collect from, not an absence of logs.
        if (!isAbsent(cause)) {
            unreadable.push(relative(root, path));
        }
        return [];
    }
}

/** The log file names in a log directory. An unreadable directory is added to `unreadable`, relative to `root`. */
export async function listLogFiles(directory: string, root: string, unreadable: string[]): Promise<readonly string[]> {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && LOG_FILE_NAME_PATTERN.test(entry.name))
            .map((entry) => entry.name)
            .sort();
    } catch (cause) {
        if (!isAbsent(cause)) {
            unreadable.push(relative(root, directory));
        }
        return [];
    }
}

type DirectoryStatus = "listed" | "skipped" | "unreadable";

/**
 * Classify a directory without changing it. Symlinks are rejected so a planted
 * link cannot redirect the report outside the state root, and the owner check
 * keeps another user's files out of it; both are deliberate exclusions rather
 * than collection failures.
 */
async function directoryStatus(path: string): Promise<DirectoryStatus> {
    let metadata: Stats;
    try {
        metadata = await lstat(path);
    } catch (cause) {
        return isAbsent(cause) ? "skipped" : "unreadable";
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) {
        return "skipped";
    }
    return "listed";
}

export type OwnedLogFileRead =
    | { readonly kind: "read"; readonly content: string }
    | { readonly kind: "skipped" }
    | { readonly kind: "unreadable" };

/** Reads a log file this user owns. Absent files, links and other users' files are skipped. */
export async function readOwnedLogFile(path: string, signal: AbortSignal): Promise<OwnedLogFileRead> {
    let metadata: Stats;
    try {
        metadata = await lstat(path);
    } catch (cause) {
        return isAbsent(cause) ? { kind: "skipped" } : { kind: "unreadable" };
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) {
        return { kind: "skipped" };
    }
    try {
        return { kind: "read", content: await readFile(path, { encoding: "utf8", signal }) };
    } catch (cause) {
        // Cancellation is not evidence about the file: let it propagate so the
        // command fails as aborted rather than reporting a healthy log as broken.
        if (signal.aborted) {
            throw cause;
        }
        return { kind: "unreadable" };
    }
}

function ownedByCurrentUser(metadata: { readonly uid: number }): boolean {
    // Windows reports uid 0 for every file, so ownership is not a signal there.
    return process.getuid === undefined || metadata.uid === process.getuid();
}
