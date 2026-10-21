import { lstat } from "node:fs/promises";
import { platformSupportFor } from "../../platform/index.ts";
import { LocalPathError } from "./path-error.ts";

export { LocalPathError } from "./path-error.ts";

export async function validateLocalPath(
    path: string,
    directory: boolean,
    privateAccess: boolean,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile())) {
        throw new LocalPathError("Unsafe local path");
    }
    await platformSupportFor(process.platform).validatePathPermissions(path, directory, privateAccess, signal);
}
