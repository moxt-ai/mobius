import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const contentRequest = /^mobius-content:(image|audio|resource):([a-f0-9]{64})$/u;
const metadataSchema = z.strictObject({
    kind: z.enum(["image", "audio", "resource"]),
    mediaType: z
        .string()
        .min(1)
        .max(2_048)
        .regex(/^[\u0020-\u007e]+$/u),
    name: z.string().min(1).max(500),
});

export type ExternalContentKind = "image" | "audio" | "resource";

export interface ExternalContentReference {
    readonly byteLength: number;
    readonly key: string;
}

export interface ResolvedExternalContent {
    readonly mediaType: string;
    readonly name: string;
    readonly path: string;
}

export interface ExternalContentStore {
    readonly put: (input: {
        readonly bytes: Uint8Array;
        readonly kind: ExternalContentKind;
        readonly mediaType: string;
        readonly name: string;
        readonly sessionId: string;
        readonly signal: AbortSignal;
    }) => Promise<ExternalContentReference>;
    readonly resolve: (
        sessionId: string,
        request: string,
        signal: AbortSignal,
    ) => Promise<ResolvedExternalContent | null>;
}

export class UnretainedExternalContentStore implements ExternalContentStore {
    readonly put: ExternalContentStore["put"] = async ({ bytes, signal }) => {
        signal.throwIfAborted();
        return { byteLength: bytes.byteLength, key: createHash("sha256").update(bytes).digest("hex") };
    };

    readonly resolve: ExternalContentStore["resolve"] = (_sessionId, _request, signal) => {
        signal.throwIfAborted();
        return Promise.resolve(null);
    };
}

function sessionScope(sessionId: string): string {
    return createHash("sha256").update(sessionId).digest("hex");
}

async function atomicWrite(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, bytes, { mode: 0o600, signal });
        signal.throwIfAborted();
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

export class LocalExternalContentStore implements ExternalContentStore {
    readonly #root: string;

    constructor(stateDirectory: string) {
        this.#root = join(stateDirectory, "tmp", "session-content");
    }

    readonly put: ExternalContentStore["put"] = async ({ bytes, kind, mediaType, name, sessionId, signal }) => {
        signal.throwIfAborted();
        const key = createHash("sha256").update(bytes).digest("hex");
        const directory = join(this.#root, sessionScope(sessionId), kind);
        await mkdir(directory, { mode: 0o700, recursive: true });
        signal.throwIfAborted();
        const path = join(directory, key);
        await atomicWrite(path, bytes, signal);
        await atomicWrite(
            `${path}.json`,
            Buffer.from(JSON.stringify(metadataSchema.parse({ kind, mediaType, name })), "utf8"),
            signal,
        );
        return { byteLength: bytes.byteLength, key };
    };

    readonly resolve: ExternalContentStore["resolve"] = async (sessionId, request, signal) => {
        const matched = contentRequest.exec(request);
        if (matched === null) {
            return null;
        }
        const kind = matched[1];
        const key = matched[2];
        if ((kind !== "image" && kind !== "audio" && kind !== "resource") || key === undefined) {
            return null;
        }
        const directory = join(this.#root, sessionScope(sessionId), kind);
        const path = join(directory, key);
        try {
            const [resolvedDirectory, resolvedPath, file, metadata] = await Promise.all([
                realpath(directory),
                realpath(path),
                lstat(path),
                readFile(`${path}.json`, "utf8").then((value) => metadataSchema.parse(JSON.parse(value) as unknown)),
            ]);
            signal.throwIfAborted();
            if (!file.isFile() || dirname(resolvedPath) !== resolvedDirectory || metadata.kind !== kind) {
                return null;
            }
            await stat(resolvedPath);
            signal.throwIfAborted();
            return { mediaType: metadata.mediaType, name: metadata.name, path: resolvedPath };
        } catch {
            signal.throwIfAborted();
            return null;
        }
    };
}
