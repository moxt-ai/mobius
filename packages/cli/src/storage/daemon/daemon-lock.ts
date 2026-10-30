import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";

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
            return async () => await unlink(path).catch(() => undefined);
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
            await unlink(path).catch(() => undefined);
        }
    }
    return null;
}

/** Keep the released lock filename; a dead owner does not keep the daemon alive. */
export async function daemonLockExists(stateDirectory: InstallationDirectory): Promise<boolean> {
    try {
        const pid = Number((await readFile(join(stateDirectory, "manager.lock"), "utf8")).trim());
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
        throw cause;
    }
}
