import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const contentRequest = /^mobius-content:(image|audio|resource):([a-f0-9]{64})$/u;
const CONTENT_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1_000;
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

interface CachedContent extends ResolvedExternalContent {
    readonly byteLength: number;
    readonly expiresAt: number;
    readonly sessions: ReadonlySet<string>;
}

/** Files are disposable; authorization grants and metadata never leave memory. */
export class LocalExternalContentStore implements ExternalContentStore, AsyncDisposable {
    readonly #root: string;
    readonly #entries = new Map<string, CachedContent>();
    readonly #operations = new Set<Promise<unknown>>();
    readonly #lifetime = new AbortController();
    readonly #expirationTimer: ReturnType<typeof setInterval>;
    #cleanup: Promise<void> = Promise.resolve();

    constructor(stateDirectory: string) {
        this.#root = join(stateDirectory, "tmp", "session-content", randomUUID());
        this.#expirationTimer = setInterval(() => {
            // A cleanup failure must not interrupt Agent output. The next pass retries.
            void this.#expire().catch(() => undefined);
        }, 60_000);
        this.#expirationTimer.unref();
    }

    readonly #expire = (): Promise<void> => {
        this.#cleanup = this.#cleanup
            .catch(() => undefined)
            .then(async () => {
                // Refresh the owner directory lease. A later daemon can remove directories
                // left by a crash without deleting another running daemon's files.
                await mkdir(this.#root, { mode: 0o700, recursive: true });
                const now = new Date();
                await utimes(this.#root, now, now);
                for (const directory of await readdir(dirname(this.#root), { withFileTypes: true })) {
                    if (!directory.isDirectory() || !/^[a-f0-9-]{36}$/u.test(directory.name)) {
                        continue;
                    }
                    const path = join(dirname(this.#root), directory.name);
                    if (path === this.#root) {
                        continue;
                    }
                    // Another daemon may remove its own directory during this scan.
                    const modified = await stat(path).then(
                        (entry) => entry.mtimeMs,
                        () => Date.now(),
                    );
                    if (modified + CONTENT_LIFETIME_MILLISECONDS <= Date.now()) {
                        await rm(path, { force: true, recursive: true });
                    }
                }
                for (const [request, entry] of this.#entries) {
                    if (entry.expiresAt > Date.now()) {
                        continue;
                    }
                    await rm(entry.path, { force: true });
                    this.#entries.delete(request);
                }
            });
        return this.#cleanup;
    };

    readonly #track = async <T>(operation: () => Promise<T>): Promise<T> => {
        this.#lifetime.signal.throwIfAborted();
        const pending = operation();
        this.#operations.add(pending);
        try {
            return await pending;
        } finally {
            this.#operations.delete(pending);
        }
    };

    readonly put: ExternalContentStore["put"] = (input) => this.#track(() => this.#put(input));

    readonly #put: ExternalContentStore["put"] = async ({ bytes, kind, mediaType, name, sessionId, signal }) => {
        const active = AbortSignal.any([signal, this.#lifetime.signal]);
        active.throwIfAborted();
        const metadata = metadataSchema.parse({ kind, mediaType, name });
        const key = createHash("sha256").update(bytes).digest("hex");
        const request = `mobius-content:${kind}:${key}`;
        const existing = this.#entries.get(request);
        if (existing !== undefined && existing.expiresAt > Date.now()) {
            this.#entries.set(request, {
                ...existing,
                expiresAt: Date.now() + CONTENT_LIFETIME_MILLISECONDS,
                sessions: new Set([...existing.sessions, sessionId]),
            });
            return { byteLength: existing.byteLength, key };
        }
        await this.#expire();
        active.throwIfAborted();
        const directory = join(this.#root, kind);
        await mkdir(directory, { mode: 0o700, recursive: true });
        active.throwIfAborted();
        const path = join(directory, key);
        const write = atomicWrite(path, bytes, active);
        await write;
        active.throwIfAborted();
        const retained = this.#entries.get(request);
        this.#entries.set(request, {
            byteLength: bytes.byteLength,
            expiresAt: Date.now() + CONTENT_LIFETIME_MILLISECONDS,
            mediaType: metadata.mediaType,
            name: metadata.name,
            path,
            sessions: new Set([...(retained?.sessions ?? []), sessionId]),
        });
        return { byteLength: bytes.byteLength, key };
    };

    readonly resolve: ExternalContentStore["resolve"] = (sessionId, request, signal) =>
        this.#track(() => this.#resolve(sessionId, request, AbortSignal.any([signal, this.#lifetime.signal])));

    readonly #resolve: ExternalContentStore["resolve"] = async (sessionId, request, signal) => {
        signal.throwIfAborted();
        this.#lifetime.signal.throwIfAborted();
        if (!contentRequest.test(request)) {
            return null;
        }
        const entry = this.#entries.get(request);
        if (entry === undefined || !entry.sessions.has(sessionId)) {
            return null;
        }
        if (entry.expiresAt <= Date.now()) {
            await this.#expire();
            signal.throwIfAborted();
            return null;
        }
        try {
            const [resolvedDirectory, resolvedPath, file] = await Promise.all([
                realpath(dirname(entry.path)),
                realpath(entry.path),
                lstat(entry.path),
            ]);
            signal.throwIfAborted();
            if (!file.isFile() || file.isSymbolicLink() || dirname(resolvedPath) !== resolvedDirectory) {
                return null;
            }
            return { mediaType: entry.mediaType, name: entry.name, path: resolvedPath };
        } catch {
            signal.throwIfAborted();
            return null;
        }
    };

    readonly [Symbol.asyncDispose] = async (): Promise<void> => {
        clearInterval(this.#expirationTimer);
        this.#lifetime.abort();
        await Promise.allSettled([...this.#operations, this.#cleanup]);
        this.#entries.clear();
        await rm(this.#root, { force: true, recursive: true });
    };
}
