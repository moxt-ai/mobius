import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { readStateDirectory } from "../../../../storage/state-directory.ts";

const LOG_FILE_NAME_PATTERN = /^[\w.-]{1,128}\.log$/u;
const INSTALLATIONS_DIRECTORY = "installations";
const VERSIONS_DIRECTORY = "versions";

export interface LocalLogEntry {
    /** Path relative to the state root, so a report never leaks a home directory. */
    readonly path: string;
    readonly lines: readonly string[];
    readonly omittedLines: number;
}

export interface CollectedLocalLogs {
    readonly entries: readonly LocalLogEntry[];
    /** Logs that exist on disk but could not be read, as state-relative paths. */
    readonly unreadable: readonly string[];
}

/**
 * Read the bounded local diagnostic logs of every installation under the state
 * root. Works with the daemon stopped: a report about a daemon that will not
 * start, or a worker that died silently, has to be collectable from disk alone.
 *
 * Covers both log owners: the Runtime's own `daemon.log` under the version-scoped
 * CLI installation, and the manager-written worker lifecycle and unhandled
 * rejection logs under the control installation.
 *
 * This is a read-only forensic path, so it never repairs anything: permissions
 * are checked without `chmod`, and a file that cannot be read is reported as
 * unreadable instead of being skipped, because silently dropping evidence would
 * make a report from a read-only mount or a failing disk look empty.
 */
export async function collectLocalDaemonLogs(
    stateDirectory: string,
    tailLines: number,
    signal: AbortSignal,
): Promise<CollectedLocalLogs> {
    signal.throwIfAborted();
    const root = resolve(stateDirectory);
    const entries: LocalLogEntry[] = [];
    const unreadable: string[] = [];
    for (const directory of await findLogDirectories(root, signal)) {
        for (const name of await listLogFiles(directory)) {
            const path = join(directory, name);
            const reported = relative(root, path);
            const read = await readLog(path, tailLines, signal);
            if (read === null) {
                unreadable.push(reported);
                continue;
            }
            entries.push({ ...read, path: reported });
        }
    }
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { entries, unreadable: unreadable.sort() };
}

export function defaultStateDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
    return resolve(readStateDirectory(environment));
}

/**
 * Resolve the installation log directories. The installation store produces two
 * shapes: `<root>/installations/<appId>/<installationId>` for the control
 * installation, and the same path under `versions/<version>/` for a version-
 * scoped CLI installation. These are enumerated instead of walked, because the
 * state root also holds Agent adapters with their own node_modules trees.
 */
async function findLogDirectories(root: string, signal: AbortSignal): Promise<readonly string[]> {
    const versions = join(root, VERSIONS_DIRECTORY);
    const installationsRoots: string[] = [join(root, INSTALLATIONS_DIRECTORY)];
    for (const version of await listDirectories(versions, signal)) {
        installationsRoots.push(join(versions, version, INSTALLATIONS_DIRECTORY));
    }
    const found: string[] = [];
    for (const installations of installationsRoots) {
        for (const applicationId of await listDirectories(installations, signal)) {
            const application = join(installations, applicationId);
            for (const installationId of await listDirectories(application, signal)) {
                const logs = join(application, installationId, "logs");
                if (await isOwnedDirectory(logs)) {
                    found.push(logs);
                }
            }
        }
    }
    return found;
}

async function listLogFiles(directory: string): Promise<readonly string[]> {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && LOG_FILE_NAME_PATTERN.test(entry.name))
            .map((entry) => entry.name)
            .sort();
    } catch {
        return [];
    }
}

async function listDirectories(path: string, signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted();
    try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
    } catch {
        return [];
    }
}

/**
 * Confirm a directory this user owns, without changing it. Symlinks are rejected
 * so a planted link cannot redirect the report outside the state root, and the
 * owner check keeps another user's files out of it.
 */
async function isOwnedDirectory(path: string): Promise<boolean> {
    try {
        const metadata = await lstat(path);
        return metadata.isDirectory() && !metadata.isSymbolicLink() && ownedByCurrentUser(metadata);
    } catch {
        return false;
    }
}

async function readLog(
    path: string,
    tailLines: number,
    signal: AbortSignal,
): Promise<Omit<LocalLogEntry, "path"> | null> {
    try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) {
            return null;
        }
        const content = await readFile(path, { encoding: "utf8", signal });
        const lines = content.split("\n").filter((line) => line.length > 0);
        return {
            lines: lines.slice(-tailLines),
            omittedLines: Math.max(0, lines.length - tailLines),
        };
    } catch {
        return null;
    }
}

function ownedByCurrentUser(metadata: { readonly uid: number }): boolean {
    // Windows reports uid 0 for every file, so ownership is not a signal there.
    return process.getuid === undefined || metadata.uid === process.getuid();
}
