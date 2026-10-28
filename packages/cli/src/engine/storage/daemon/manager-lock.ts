import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "../../util/node-error.ts";
import type { InstallationDirectory } from "../installation/installation-files.ts";

/**
 * Takes the lock file that makes this process the only holder of a daemon role. A lock left by a
 * process that is gone is replaced. Returns the release function, or null when a live process holds it.
 */
export async function acquireManagerLock(
    stateDirectory: InstallationDirectory,
    name = "manager.lock",
): Promise<(() => Promise<void>) | null> {
    const path = join(stateDirectory, name);
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

/** True while the manager lock file exists. */
export async function managerLockExists(stateDirectory: InstallationDirectory): Promise<boolean> {
    try {
        await readFile(join(stateDirectory, "manager.lock"), "utf8");
        return true;
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return false;
        }
        throw cause;
    }
}
