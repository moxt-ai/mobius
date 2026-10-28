import { join, relative, resolve } from "node:path";

import { findLogDirectories, listLogFiles, readOwnedLogFile } from "../../../../storage/logs/log-files.ts";
import { readStateDirectory } from "../../../../storage/state-directory.ts";

export interface LocalLogEntry {
    /** Path relative to the state root, so a report never leaks a home directory. */
    readonly path: string;
    readonly lines: readonly string[];
    readonly omittedLines: number;
}

export interface CollectedLocalLogs {
    readonly entries: readonly LocalLogEntry[];
    /**
     * Logs and log directories that could not be read, as state-relative paths.
     * A directory entry means it could not be listed, so its files are unknown.
     * Deliberately distinct from "absent": only ENOENT counts as absent, so a
     * permission or I/O failure is never reported as an empty machine.
     */
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
 * are checked without `chmod`, and anything that cannot be read is reported as
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
    const directories = await findLogDirectories(root, unreadable, signal);
    for (const directory of directories) {
        const names = await listLogFiles(directory, root, unreadable);
        for (const name of names) {
            const path = join(directory, name);
            const reported = relative(root, path);
            const read = await readOwnedLogFile(path, signal);
            if (read.kind === "unreadable") {
                unreadable.push(reported);
                continue;
            }
            if (read.kind === "skipped") {
                continue;
            }
            const lines = read.content.split("\n").filter((line) => line.length > 0);
            entries.push({
                lines: lines.slice(-tailLines),
                omittedLines: Math.max(0, lines.length - tailLines),
                path: reported,
            });
        }
    }
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { entries, unreadable: [...unreadable].sort() };
}

export function defaultStateDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
    return resolve(readStateDirectory(environment));
}
