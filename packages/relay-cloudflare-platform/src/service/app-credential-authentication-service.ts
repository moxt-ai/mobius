import { decodeProjectPermissions, hashSecret, ProjectAuthenticationError } from "@moxt-ai/mobius-relay-core";
import { type PlatformApplicationIdentity, PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { CredentialRow } from "../entity/platform-records.ts";
import { AppCredentialCacheError, type AppCredentialCacheStorage } from "../storage/app-credential-cache-storage.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";

export class AppCredentialAuthenticationService {
    readonly #storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId" | "touchCredential">;
    readonly #cache: AppCredentialCacheStorage;

    constructor(
        storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId" | "touchCredential">,
        cache: AppCredentialCacheStorage,
    ) {
        this.#storage = storage;
        this.#cache = cache;
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

    readonly invalidate = async (row: CredentialRow, signal: AbortSignal): Promise<void> => {
        try {
            await this.#cache.invalidate(row.secret_digest, signal);
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
}

function constantTimeEqual(left: string, right: string): boolean {
    const maximum = Math.max(left.length, right.length);
    let difference = left.length ^ right.length;
    for (let index = 0; index < maximum; index++) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}
