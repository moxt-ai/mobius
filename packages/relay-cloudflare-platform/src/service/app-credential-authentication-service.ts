import { decodeProjectPermissions, hashSecret, ProjectAuthenticationError } from "@moxt-ai/mobius-relay-core";
import { DatabaseError } from "@moxt-ai/mobius-relay-core/database";
import { type PlatformApplicationIdentity, PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { CredentialRow } from "../entity/platform-records.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";

// A use observed within this long of the recorded one is not written again, so authorizing every request,
// such as each long-poll page of a Recording read, does not write D1 for the same credential each time.
const USAGE_OBSERVATION_INTERVAL_MILLISECONDS = 60_000;

export interface AppCredentialBackgroundTasks {
    readonly waitUntil: (operation: Promise<void>) => void;
}

export class AppCredentialAuthenticationService {
    readonly #storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId" | "touchCredential">;
    readonly #backgroundTasks: AppCredentialBackgroundTasks;

    constructor(
        storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId" | "touchCredential">,
        backgroundTasks: AppCredentialBackgroundTasks,
    ) {
        this.#storage = storage;
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
        const row = await this.readCredential(publicCredentialId, signal);
        if (!constantTimeEqual(digest, row.secret_digest)) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        const now = Date.now();
        requireActiveCredential(row, now);
        this.touchLater(row, now);
        return row;
    };

    readonly readActiveCredentialByPublicId = async (
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<CredentialRow> => {
        const credential = await this.readCredential(publicCredentialId, signal);
        const now = Date.now();
        requireActiveCredential(credential, now);
        this.touchLater(credential, now);
        return credential;
    };

    private readonly readCredential = async (
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<CredentialRow> => {
        signal.throwIfAborted();
        try {
            // Read the D1 primary on every authorization. A snapshot may serve this check only;
            // checks started after a committed revocation must observe that revocation.
            const row = await this.#storage.readCredentialByPublicId(publicCredentialId, signal);
            if (row === null) {
                throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
            }
            return row;
        } catch (cause) {
            signal.throwIfAborted();
            if (
                cause instanceof DatabaseError &&
                (cause.code === "database_unavailable" || cause.code === "database_timeout")
            ) {
                throw new PlatformControlPlaneError(cause.code, "App authentication is unavailable", 503, { cause });
            }
            throw cause;
        }
    };

    private readonly touchLater = (credential: CredentialRow, usedAt: number): void => {
        const observedAt = credential.last_observed_used_at;
        if (
            observedAt !== null &&
            usedAt >= observedAt &&
            usedAt - observedAt < USAGE_OBSERVATION_INTERVAL_MILLISECONDS
        ) {
            return;
        }
        const credentialId = credential.credential_id;
        // Authorization runs in RuntimeRelay too; an uncancellable AbortSignal.timeout would keep it awake
        // for the whole deadline after a fast update.
        const timeout = new AbortController();
        const timer = setTimeout(
            () => timeout.abort(new DOMException("The last-used update timed out", "TimeoutError")),
            15_000,
        );
        const operation = this.#storage
            .touchCredential(credentialId, usedAt, timeout.signal)
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

/** Whether an AppCredential authenticates now. Authentication and every listing apply this one rule. */
export function appCredentialActive(row: CredentialRow, now: number): boolean {
    return (
        row.revoked_at === null &&
        (row.replaced_by_credential_id === null ||
            (typeof row.overlap_ends_at === "number" && row.overlap_ends_at > now)) &&
        row.app_lifecycle === "active" &&
        row.tenant_lifecycle === "active"
    );
}

function requireActiveCredential(row: CredentialRow, now: number): void {
    if (!appCredentialActive(row, now)) {
        throw new ProjectAuthenticationError("credential_revoked", "The AppCredential is no longer active");
    }
}

function constantTimeEqual(left: string, right: string): boolean {
    const maximum = Math.max(left.length, right.length);
    let difference = left.length ^ right.length;
    for (let index = 0; index < maximum; index++) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}
