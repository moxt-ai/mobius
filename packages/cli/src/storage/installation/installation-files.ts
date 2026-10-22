import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNodeError } from "../../util/node-error.ts";

// One application's installations live in `<root>/installations/<applicationId>/`. `current.json`
// points at the current installation, whose directory keeps one file per saved connection in
// `connections/` and one index file per relay channel in `channels/`.

const MAXIMUM_FILE_BYTES = 16 * 1024;

export function applicationDirectory(root: string, applicationId: string): string {
    return join(root, "installations", applicationId);
}

export function installationPointerPath(applicationDirectory: string): string {
    return join(applicationDirectory, "current.json");
}

export function installationDirectory(applicationDirectory: string, installationId: string): string {
    return join(applicationDirectory, installationId);
}

export function connectionDirectory(installationDirectory: string): string {
    return join(installationDirectory, "connections");
}

export function connectionFilePath(connectionDirectory: string, connectionId: string): string {
    return join(connectionDirectory, `${connectionId}.json`);
}

/** Channel index files are named by a hash, so a channel ID never becomes part of a path. */
export function channelIndexFilePath(installationDirectory: string, channelId: string): string {
    return join(installationDirectory, "channels", `mci_${createHash("sha256").update(channelId).digest("hex")}.json`);
}

export type InstallationFileRead =
    | { readonly kind: "read"; readonly text: string }
    | { readonly kind: "missing"; readonly cause: unknown }
    | { readonly kind: "unopenable"; readonly cause: unknown }
    | { readonly kind: "not-a-small-file" };

/** Reads a small regular file. Errors after the file is open propagate. */
export async function readInstallationFile(path: string): Promise<InstallationFileRead> {
    let handle: FileHandle;
    try {
        handle = await open(path, "r");
    } catch (cause) {
        return isNodeError(cause, "ENOENT") ? { kind: "missing", cause } : { kind: "unopenable", cause };
    }
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAXIMUM_FILE_BYTES) {
            return { kind: "not-a-small-file" };
        }
        return { kind: "read", text: await handle.readFile({ encoding: "utf8" }) };
    } finally {
        await handle.close();
    }
}

/** Replaces a file atomically with owner-only permissions, creating its directory when it is missing. */
export async function writeInstallationFile(path: string, text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
    try {
        await mkdir(directory, { mode: 0o700, recursive: true });
        signal.throwIfAborted();
        await writeFile(temporaryPath, text, { flag: "wx", mode: 0o600 });
        signal.throwIfAborted();
        await rename(temporaryPath, path);
    } catch (cause) {
        await unlink(temporaryPath).catch(() => undefined);
        throw cause;
    }
}

/** Creates a file with owner-only permissions. Fails with `EEXIST` when it already exists. */
export async function createInstallationFile(path: string, text: string): Promise<void> {
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
}

export async function listInstallationFiles(directory: string): Promise<readonly string[]> {
    return await readdir(directory);
}

export async function removeInstallationFile(path: string): Promise<void> {
    await unlink(path);
}
