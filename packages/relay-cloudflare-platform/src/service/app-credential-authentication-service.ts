import { decodeProjectPermissions, hashSecret, ProjectAuthenticationError } from "@moxt-ai/mobius-relay-core";
import { type PlatformApplicationIdentity, PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { CredentialRow } from "../entity/platform-records.ts";
import { AppCredentialCacheError, type AppCredentialCacheStorage } from "../storage/app-credential-cache-storage.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";

export interface AppCredentialBackgroundTasks {
    readonly waitUntil: (operation: Promise<void>) => void;
}

export class AppCredentialAuthenticationService {
    readonly #storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId" | "touchCredential">;
    readonly #cache: AppCredentialCacheStorage;
    readonly #backgroundTasks: AppCredentialBackgroundTasks;

    constructor(
        storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId" | "touchCredential">,
        cache: AppCredentialCacheStorage,
        backgroundTasks: AppCredentialBackgroundTasks,
    ) {
        this.#storage = storage;
        this.#cache = cache;
        this.#backgroundTasks = backgroundTasks;
    }

    readonly authenticate = async (credential: string, signal: AbortSignal): Promise<PlatformApplicationIdentity> => {
        try {
            const row = await this.verify(credential, signal);
            const encoded: unknown = JSON.parse(row.permissions_json);
            const permissions = decodeProjectPermissions(encoded);
            return {
                kind: "application",
                tenantId: row.tenant_id,
                appId: row.app_id,
                credentialId: row.credential_id,
                permissions,
                scope: row.all_projects === 1 ? "all-projects" : "selected-projects",
            };
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof ProjectAuthenticationError) {
                throw new PlatformControlPlaneError(cause.code, "App authentication failed", 401, { cause });
            }
            throw cause;
        }
    };

    readonly verify = async (credentialValue: string, signal: AbortSignal): Promise<CredentialRow> => {
        signal.throwIfAborted();
        const match = /^mapp_([a-zA-Z0-9_-]{22})_([a-zA-Z0-9_-]{43})$/.exec(credentialValue);
        const publicCredentialId = match?.[1];
        if (publicCredentialId === undefined) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        const digest = await hashSecret(credentialValue);
        signal.throwIfAborted();
        const cached = await this.#cache.read(digest, signal);
        if (cached !== null && cached.public_credential_id === publicCredentialId) {
            this.requireActive(cached);
            return cached;
        }
        const validatedAt = Date.now();
        const row = await this.#storage.readCredentialByPublicId(publicCredentialId, signal);
        if (row === null) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        if (!constantTimeEqual(digest, row.secret_digest)) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        if (this.isInactive(row)) {
            await this.#cache.write(row, validatedAt, signal);
            this.requireActive(row);
        }
        const now = Date.now();
        if (!(await this.#storage.touchCredential(row.credential_id, now, signal))) {
            throw new ProjectAuthenticationError("credential_revoked", "The AppCredential is no longer active");
        }
        const used = { ...row, last_used_at: now };
        await this.#cache.write(used, validatedAt, signal);
        this.requireActive(used);
        return used;
    };

    readonly readActiveCredentialByPublicId = async (
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<CredentialRow> => {
        signal.throwIfAborted();
        const cached = await this.#cache.readByPublicId(publicCredentialId, signal);
        if (cached !== null) {
            this.requireActive(cached);
            this.touchLater(cached.credential_id);
            return cached;
        }
        const validatedAt = Date.now();
        const credential = await this.#storage.readCredentialByPublicId(publicCredentialId, signal);
        if (credential === null) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        this.requireActive(credential);
        await this.#cache.write(credential, validatedAt, signal);
        this.touchLater(credential.credential_id);
        return credential;
    };

    readonly invalidate = async (row: CredentialRow, signal: AbortSignal): Promise<void> => {
        try {
            await this.#cache.invalidate(row, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new PlatformControlPlaneError(
                cause instanceof AppCredentialCacheError && cause.code === "app_credential_cache_timeout"
                    ? "app_credential_cache_invalidation_timeout"
                    : "app_credential_cache_invalidation_failed",
                "The credential changed but its cache could not be invalidated",
                503,
                { cause },
            );
        }
    };

    private readonly isInactive = (row: CredentialRow): boolean =>
        row.revoked_at !== null ||
        (row.replaced_by_credential_id !== null &&
            (typeof row.overlap_ends_at !== "number" || row.overlap_ends_at <= Date.now())) ||
        row.app_lifecycle !== "active" ||
        row.tenant_lifecycle !== "active";

    private readonly requireActive = (row: CredentialRow): void => {
        if (this.isInactive(row)) {
            throw new ProjectAuthenticationError("credential_revoked", "The AppCredential is no longer active");
        }
    };

    private readonly touchLater = (credentialId: string): void => {
        // Authorization runs in RuntimeRelay too; an uncancellable AbortSignal.timeout would keep it awake
        // for the whole deadline after a fast update.
        const timeout = new AbortController();
        const timer = setTimeout(
            () => timeout.abort(new DOMException("The last-used update timed out", "TimeoutError")),
            15_000,
        );
        const operation = this.#storage
            .touchCredential(credentialId, Date.now(), timeout.signal)
            .then((updated) => {
                if (!updated) {
                    console.warn("App credential last-used update skipped", {
                        code: "app_credential_inactive",
                        credentialId,
                    });
                }
            })
            .catch((cause: unknown) => {
                console.warn("App credential last-used update failed", {
                    code: "app_credential_last_used_update_failed",
                    credentialId,
                    cause,
                });
            })
            .finally(() => clearTimeout(timer));
        this.#backgroundTasks.waitUntil(operation);
    };
}

function constantTimeEqual(left: string, right: string): boolean {
    const maximum = Math.max(left.length, right.length);
    let difference = left.length ^ right.length;
    for (let index = 0; index < maximum; index++) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}
