import { lstat } from "node:fs/promises";
import { LocalPathError } from "../../util/filesystem/path-error.ts";

/** Validate the local peer before sending the daemon's control credential. */
export async function validateControlSocket(path: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (process.platform === "win32") {
        return;
    }
    const metadata = await lstat(path);
    signal.throwIfAborted();
    if (!metadata.isSocket() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
        throw new LocalPathError("The terminal socket must be private and owned by the current user");
    }
}
