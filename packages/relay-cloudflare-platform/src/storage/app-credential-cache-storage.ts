import * as v from "valibot";
import { type CredentialRow, CredentialRowSchema } from "../entity/platform-records.ts";

const CACHE_LIFETIME_MILLISECONDS = 2 * 60 * 60 * 1_000;
const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const cacheRecord = v.strictObject({
    version: v.literal(1),
    validatedAt: timestamp,
    expiresAt: timestamp,
    credential: CredentialRowSchema,
});

export class AppCredentialCacheError extends Error {
    readonly code: "app_credential_cache_timeout" | "app_credential_cache_unavailable";

    constructor(code: AppCredentialCacheError["code"], cause: unknown) {
        super("The App credential cache is unavailable", { cause });
        this.name = "AppCredentialCacheError";
        this.code = code;
    }
}

/** One hash-keyed record, with an absolute expiry that cache hits never extend. */
export class AppCredentialCacheStorage {
    readonly #namespace: KVNamespace;

    constructor(namespace: KVNamespace) {
        this.#namespace = namespace;
    }

    readonly read = async (digest: string, signal: AbortSignal): Promise<CredentialRow | null> => {
        const credential = await this.readRecord(this.secretKey(digest), signal);
        return credential?.secret_digest === digest ? credential : null;
    };

    readonly readByPublicId = async (
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<CredentialRow | null> => {
        const credential = await this.readRecord(this.publicIdKey(publicCredentialId), signal);
        return credential?.public_credential_id === publicCredentialId ? credential : null;
    };

    private readonly readRecord = async (key: string, signal: AbortSignal): Promise<CredentialRow | null> => {
        let encoded: string | null;
        try {
            encoded = await this.operation(() => this.#namespace.get(key, { cacheTtl: 60 }), signal);
        } catch (cause) {
            signal.throwIfAborted();
            if (!(cause instanceof AppCredentialCacheError)) {
                throw cause;
            }
            // Cache outages fall back to authoritative authentication in D1.
            return null;
        }
        if (encoded === null) {
            return null;
        }
        let value: unknown;
        try {
            value = JSON.parse(encoded);
        } catch {
            return null;
        }
        const parsed = v.safeParse(cacheRecord, value);
        if (!parsed.success) {
            return null;
        }
        const record = parsed.output;
        const now = Date.now();
        if (
            record.validatedAt > now ||
            record.expiresAt <= now ||
            record.expiresAt !== record.validatedAt + CACHE_LIFETIME_MILLISECONDS
        ) {
            return null;
        }
        return record.credential;
    };

    readonly write = async (credential: CredentialRow, validatedAt: number, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const expiresAt = validatedAt + CACHE_LIFETIME_MILLISECONDS;
        if (expiresAt <= Date.now()) {
            return;
        }
        const record = v.parse(cacheRecord, { version: 1, validatedAt, expiresAt, credential });
        try {
            await this.operation(
                () =>
                    Promise.all([
                        this.#namespace.put(this.secretKey(credential.secret_digest), JSON.stringify(record), {
                            expirationTtl: Math.max(60, Math.ceil((expiresAt - Date.now()) / 1_000)),
                        }),
                        this.#namespace.put(this.publicIdKey(credential.public_credential_id), JSON.stringify(record), {
                            expirationTtl: Math.max(60, Math.ceil((expiresAt - Date.now()) / 1_000)),
                        }),
                    ]).then(() => undefined),
                signal,
            );
        } catch (cause) {
            signal.throwIfAborted();
            if (!(cause instanceof AppCredentialCacheError)) {
                throw cause;
            }
            // Authentication has already succeeded in D1. Concurrent cold fills can
            // exceed KV's per-key write limit; a failed fill must not reject it.
        }
    };

    readonly invalidate = async (credential: CredentialRow, signal: AbortSignal): Promise<void> => {
        await this.operation(
            () =>
                Promise.all([
                    this.#namespace.delete(this.secretKey(credential.secret_digest)),
                    this.#namespace.delete(this.publicIdKey(credential.public_credential_id)),
                ]).then(() => undefined),
            signal,
        );
    };

    private readonly secretKey = (digest: string): string => {
        if (!/^[a-f0-9]{64}$/u.test(digest)) {
            throw new AppCredentialCacheError(
                "app_credential_cache_unavailable",
                new Error("Invalid credential digest"),
            );
        }
        return `app-secret:v1:${digest}`;
    };

    private readonly publicIdKey = (publicCredentialId: string): string => {
        if (!/^[a-zA-Z0-9_-]{22}$/u.test(publicCredentialId)) {
            throw new AppCredentialCacheError(
                "app_credential_cache_unavailable",
                new Error("Invalid public credential identifier"),
            );
        }
        return `app-public:v1:${publicCredentialId}`;
    };

    private readonly operation = async <Value>(
        operation: () => Promise<Value>,
        signal: AbortSignal,
    ): Promise<Value> => {
        signal.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 1_000);
        const deadline = AbortSignal.any([signal, timeout.signal]);
        let abort = (): void => {};
        try {
            // KV bindings cannot abort an in-flight operation; bound the caller's
            // wait and observe late rejection without retrying a mutation.
            const result = await Promise.race([
                operation(),
                new Promise<never>((_resolve, reject) => {
                    abort = () => reject(deadline.reason);
                    deadline.addEventListener("abort", abort, { once: true });
                    if (deadline.aborted) {
                        abort();
                    }
                }),
            ]);
            deadline.throwIfAborted();
            return result;
        } catch (cause) {
            signal.throwIfAborted();
            throw new AppCredentialCacheError(
                timeout.signal.aborted ? "app_credential_cache_timeout" : "app_credential_cache_unavailable",
                cause,
            );
        } finally {
            clearTimeout(timer);
            deadline.removeEventListener("abort", abort);
        }
    };
}
