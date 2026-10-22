import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { ExecutableIdentity } from "./executable.ts";

/** The identity of a local executable file as it is now. */
export function readExecutableIdentity(path: string): ExecutableIdentity {
    const resolvedPath = realpathSync(path);
    const metadata = statSync(resolvedPath);
    return new ExecutableIdentity(
        resolvedPath,
        resolvedPath,
        metadata.dev,
        metadata.ino,
        metadata.size,
        metadata.ctimeMs,
    );
}

/** The canonical paths of a launch entry and its executable, or null when either is not a regular file. */
export async function resolveLaunchFiles(
    entry: string,
    executable: string,
): Promise<{ readonly entry: string; readonly executable: string } | null> {
    const resolvedEntry = await realpath(entry);
    const resolvedExecutable = await realpath(executable);
    if (!(await stat(resolvedEntry)).isFile() || !(await stat(resolvedExecutable)).isFile()) {
        return null;
    }
    return { entry: resolvedEntry, executable: resolvedExecutable };
}
