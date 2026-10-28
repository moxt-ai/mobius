import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { canonicalPath, ensureCanonicalDirectory, readPathMetadata } from "./local-files.ts";

const ATTACHMENT_DIRECTORY = join(".morty", "prompt-attachments");

export class PromptAttachmentFileError extends Error {
    readonly code = "prompt_attachment_file_failed";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "PromptAttachmentFileError";
    }
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
    return cause instanceof Error && "code" in cause;
}

function safeFileName(name: string): string {
    const leaf = name.split(/[/\\]/u).pop() ?? "";
    const cleaned = leaf.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^[.]+/u, "");
    const limited = cleaned.slice(0, 80);
    return limited.length > 0 ? limited : "attachment";
}

function staysInside(root: string, candidate: string): boolean {
    const relation = relative(root, candidate);
    return relation.length > 0 && !relation.startsWith("..") && !isAbsolute(relation);
}

/**
 * Saves one prompt document inside the session workspace so an Agent can read it.
 * The path stays under `.morty/prompt-attachments` and refuses symbolic links.
 */
export async function writePromptAttachmentFile(
    cwd: string,
    file: { readonly bytes: Uint8Array; readonly name: string },
    signal: AbortSignal,
): Promise<string> {
    signal.throwIfAborted();
    const root = await canonicalPath(cwd);
    if ((await readPathMetadata(root)).kind !== "directory") {
        throw new PromptAttachmentFileError("The session workspace is not a directory");
    }
    const directory = await ensureCanonicalDirectory(join(root, ATTACHMENT_DIRECTORY));
    if (directory === null || !staysInside(root, directory)) {
        throw new PromptAttachmentFileError("The prompt attachment directory is outside the workspace");
    }
    const digest = createHash("sha256").update(file.bytes).digest("hex").slice(0, 16);
    const target = join(directory, `${digest}-${safeFileName(file.name)}`);
    if (!staysInside(directory, target)) {
        throw new PromptAttachmentFileError("The prompt attachment path is outside the workspace");
    }
    signal.throwIfAborted();
    try {
        const existing = await lstat(target);
        if (!existing.isFile()) {
            throw new PromptAttachmentFileError("The prompt attachment path is not a file");
        }
    } catch (cause) {
        if (cause instanceof PromptAttachmentFileError) {
            throw cause;
        }
        if (!isNodeError(cause) || cause.code !== "ENOENT") {
            throw new PromptAttachmentFileError("The prompt attachment path could not be checked", { cause });
        }
    }
    signal.throwIfAborted();
    const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
    );
    try {
        signal.throwIfAborted();
        await handle.writeFile(file.bytes);
    } finally {
        await handle.close();
    }
    return target;
}
