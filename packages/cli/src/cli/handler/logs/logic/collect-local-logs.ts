import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { readStateDirectory } from "../../../../storage/state-directory.ts";
import { validateLocalPath } from "../../../../util/filesystem/private-path.ts";

const LOG_FILE_NAME_PATTERN = /^[\w.-]{1,128}\.log$/u;
const INSTALLATIONS_DIRECTORY = "installations";
const VERSIONS_DIRECTORY = "versions";

export interface LocalLogEntry {
    /** Path relative to the state root, so a report never leaks a home directory. */
    readonly path: string;
    readonly lines: readonly string[];
    readonly omittedLines: number;
}

/**
 * Read the bounded local diagnostic logs of every installation under the state
 * root. Works with the daemon stopped: a report about a daemon that will not
 * start, or a worker that died silently, has to be collectable from disk alone.
 *
 * Covers both log owners: the Runtime's own `daemon.log` under the version-scoped
 * CLI installation, and the manager-written worker lifecycle and unhandled
 * rejection logs under the control installation. Files are read, never rotated
 * or rewritten, and an unreadable one is skipped rather than failing the report.
 */
export async function collectLocalDaemonLogs(
    stateDirectory: string,
    tailLines: number,
    signal: AbortSignal,
): Promise<readonly LocalLogEntry[]> {
    signal.throwIfAborted();
    const root = resolve(stateDirectory);
    const collected: LocalLogEntry[] = [];
    for (const directory of await findLogDirectories(root, signal)) {
        for (const name of await listLogFiles(directory)) {
            const entry = await readLog(join(directory, name), root, tailLines, signal);
            if (entry !== null) {
                collected.push(entry);
            }
        }
    }
    return collected.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
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
                if (await isPrivateDirectory(logs, signal)) {
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

async function isPrivateDirectory(path: string, signal: AbortSignal): Promise<boolean> {
    try {
        await validateLocalPath(path, true, true, signal);
        return true;
    } catch {
        return false;
    }
}

async function readLog(
    path: string,
    root: string,
    tailLines: number,
    signal: AbortSignal,
): Promise<LocalLogEntry | null> {
    try {
        await validateLocalPath(path, false, true, signal);
        const content = await readFile(path, { encoding: "utf8", signal });
        const lines = content.split("\n").filter((line) => line.length > 0);
        return {
            lines: lines.slice(-tailLines),
            omittedLines: Math.max(0, lines.length - tailLines),
            path: relative(root, path),
        };
    } catch {
        return null;
    }
}
