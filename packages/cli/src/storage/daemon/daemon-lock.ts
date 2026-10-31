import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";

/**
 * Frees the lock name in one step. On Windows a file that is being unlinked stays
 * in place until the deleting handle closes, and opening or recreating it fails
 * with EPERM meanwhile; renaming it away first means no reader or acquirer of the
 * lock name ever sees that state. A failure leaves the file in place, where its
 * dead owner's PID marks it as stale.
 */
async function removeLockFile(path: string): Promise<void> {
    const released = `${path}.${randomUUID()}.released`;
    try {
        await rename(path, released);
    } catch {
        return;
    }
    await unlink(released).catch(() => undefined);
}

/**
 * Takes the lock file that makes this process the only daemon. A lock left by a
 * process that is gone is replaced. Returns the release function, or null when a live process holds it.
 */
export async function acquireDaemonLock(
    stateDirectory: InstallationDirectory,
    filename: "manager.lock" | "worker.lock" = "manager.lock",
): Promise<(() => Promise<void>) | null> {
    const path = join(stateDirectory, filename);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await writeFile(path, `${process.pid.toString()}\n`, { flag: "wx", mode: 0o600 });
            return async () => await removeLockFile(path);
        } catch (cause) {
            if (!isNodeError(cause, "EEXIST")) {
                throw cause;
            }
            const encoded = await readFile(path, "utf8").catch(() => "");
            const pid = Number(encoded.trim());
            if (Number.isSafeInteger(pid) && pid > 1) {
                try {
                    process.kill(pid, 0);
                    return null;
                } catch (probeCause) {
                    if (!isNodeError(probeCause, "ESRCH")) {
                        return null;
                    }
                }
            }
            await removeLockFile(path);
        }
    }
    return null;
}

/** Keep the released lock filename; a dead owner does not keep the daemon alive. */
export async function daemonLockExists(
    stateDirectory: InstallationDirectory,
    filename: "manager.lock" | "worker.lock" = "manager.lock",
): Promise<boolean> {
    try {
        const pid = Number((await readFile(join(stateDirectory, filename), "utf8")).trim());
        // The exclusive file can be observed before its owner finishes writing the PID.
        if (!Number.isSafeInteger(pid) || pid <= 1) {
            return true;
        }
        try {
            process.kill(pid, 0);
        } catch (cause) {
            if (isNodeError(cause, "ESRCH")) {
                return false;
            }
            if (!isNodeError(cause, "EPERM")) {
                throw cause;
            }
        }
        return true;
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return false;
        }
        // Released versions unlink their lock in place. On Windows the file cannot
        // be opened until that deletion completes, so it still exists.
        if (isNodeError(cause, "EPERM")) {
            return true;
        }
        throw cause;
    }
}
