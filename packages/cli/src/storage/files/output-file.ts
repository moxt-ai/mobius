import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isNodeError } from "../../engine/util/node-error.ts";

export type ExistingFileWrite =
    | { readonly kind: "written" }
    | { readonly kind: "missing"; readonly cause: unknown }
    | { readonly kind: "unwritable"; readonly cause: unknown }
    | { readonly kind: "not-a-file" };

/** Replaces the content of an existing regular file, refusing to follow a symbolic link at `path`. */
export async function writeExistingFile(
    path: string,
    content: string,
    signal: AbortSignal,
): Promise<ExistingFileWrite> {
    let file: FileHandle;
    try {
        file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    } catch (cause) {
        return isNodeError(cause, "ENOENT") ? { kind: "missing", cause } : { kind: "unwritable", cause };
    }
    try {
        const metadata = await file.stat();
        if (!metadata.isFile()) {
            return { kind: "not-a-file" };
        }
        signal.throwIfAborted();
        await file.truncate(0);
        await file.writeFile(content, "utf8");
        return { kind: "written" };
    } finally {
        await file.close();
    }
}
