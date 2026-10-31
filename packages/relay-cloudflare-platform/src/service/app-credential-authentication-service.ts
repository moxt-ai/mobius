import {
    decodeRecordedProjectPermissions,
    hashSecret,
    ProjectAuthenticationError,
    type RecordedProjectPermissions,
} from "@moxt-ai/mobius-relay-core";
import { DatabaseError } from "@moxt-ai/mobius-relay-core/database";
import { logger } from "@moxt-ai/mobius-relay-core/logging";
import { type PlatformApplicationIdentity, PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { CredentialRow } from "../entity/platform-records.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";

export class AppCredentialAuthenticationService {
    readonly #storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId">;

    constructor(storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId">) {
        this.#storage = storage;
    }

    readonly authenticate = async (credential: string, signal: AbortSignal): Promise<PlatformApplicationIdentity> => {
        try {
            const row = await this.verify(credential, signal);
            const permissions = credentialPermissions(row).granted;
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
        return row;
    };

    readonly readActiveCredentialByPublicId = async (
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<CredentialRow> => {
        const credential = await this.readCredential(publicCredentialId, signal);
        const now = Date.now();
        requireActiveCredential(credential, now);
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
}

/**
 * Whether an AppCredential authenticates now. Authentication and every listing apply this one rule. It reads only
 * the credential: App deletion revokes every credential of the App in the same batch, and a credential is issued
 * only while its App is active.
 */
export function appCredentialActive(
    row: Pick<CredentialRow, "overlap_ends_at" | "replaced_by_credential_id" | "revoked_at">,
    now: number,
): boolean {
    return (
        row.revoked_at === null &&
        (row.replaced_by_credential_id === null ||
            (typeof row.overlap_ends_at === "number" && row.overlap_ends_at > now))
    );
}

/**
 * The permissions an AppCredential record holds. A newer Worker may have recorded permissions this one does not
 * know; they grant nothing here, but they do not invalidate the credential.
 */
export function credentialPermissions(
    row: Pick<CredentialRow, "credential_id" | "permissions_json">,
): RecordedProjectPermissions {
    let value: unknown;
    try {
        value = JSON.parse(row.permissions_json);
    } catch (cause) {
        throw new ProjectAuthenticationError(
            "project_authorization_record_invalid",
            "The AppCredential authorization record is invalid",
            { cause },
        );
    }
    const permissions = decodeRecordedProjectPermissions(value);
    if (permissions.unrecognized.length > 0) {
        logger.warn(
            {
                event: "project_permission_unrecognized",
                credentialId: row.credential_id,
                permissions: permissions.unrecognized,
            },
            "The AppCredential records permissions this Worker does not know",
        );
    }
    return permissions;
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
