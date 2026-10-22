import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ScratchDirectory } from "../../storage/files/scratch-directory.ts";

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

interface CachedContent extends ResolvedExternalContent {
    readonly byteLength: number;
    readonly expiresAt: number;
    readonly sessions: ReadonlySet<string>;
}

/** Files are disposable; authorization grants and metadata never leave memory. */
export class LocalExternalContentStore implements ExternalContentStore, AsyncDisposable {
    readonly #scratch: ScratchDirectory;
    readonly #entries = new Map<string, CachedContent>();
    readonly #operations = new Set<Promise<unknown>>();
    readonly #lifetime = new AbortController();
    readonly #expirationTimer: ReturnType<typeof setInterval>;
    #cleanup: Promise<void> = Promise.resolve();

    constructor(stateDirectory: string) {
        this.#scratch = new ScratchDirectory(join(stateDirectory, "tmp", "session-content"));
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
                // A later daemon can remove the directory a crashed daemon left behind
                // without deleting another running daemon's files.
                await this.#scratch.refreshLease(CONTENT_LIFETIME_MILLISECONDS);
                for (const [request, entry] of this.#entries) {
                    if (entry.expiresAt > Date.now()) {
                        continue;
                    }
                    await this.#scratch.remove(entry.path);
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
        const path = await this.#scratch.write(kind, key, bytes, active);
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
        const resolvedPath = await this.#scratch.resolveFile(entry.path);
        signal.throwIfAborted();
        return resolvedPath === null ? null : { mediaType: entry.mediaType, name: entry.name, path: resolvedPath };
    };

    readonly [Symbol.asyncDispose] = async (): Promise<void> => {
        clearInterval(this.#expirationTimer);
        this.#lifetime.abort();
        await Promise.allSettled([...this.#operations, this.#cleanup]);
        this.#entries.clear();
        await this.#scratch.removeAll();
    };
}
