import { decodeProjectPermissions, hashSecret, ProjectAuthenticationError } from "@moxt-ai/mobius-relay-core";
import { type PlatformApplicationIdentity, PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { CredentialRow } from "../entity/platform-records.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";

export class AppCredentialAuthenticationService {
    readonly #storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId" | "touchCredential">;

    constructor(storage: Pick<PlatformControlPlaneStorage, "readCredentialByPublicId" | "touchCredential">) {
        this.#storage = storage;
    }

    readonly authenticate = async (credential: string, signal: AbortSignal): Promise<PlatformApplicationIdentity> => {
        try {
            const row = await this.verify(credential, signal);
            const encoded: unknown = JSON.parse(row.permissions_json);
            const permissions = decodeProjectPermissions(encoded);
            if (!(await this.#storage.touchCredential(row.credential_id, Date.now(), signal))) {
                throw new ProjectAuthenticationError("credential_revoked", "The App credential is inactive");
            }
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
        const row = await this.#storage.readCredentialByPublicId(publicCredentialId, signal);
        if (row === null) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        const digest = await hashSecret(credentialValue);
        signal.throwIfAborted();
        if (!constantTimeEqual(digest, row.secret_digest)) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        const now = Date.now();
        if (
            row.revoked_at !== null ||
            (row.replaced_by_credential_id !== null &&
                (typeof row.overlap_ends_at !== "number" || row.overlap_ends_at <= now)) ||
            row.app_lifecycle !== "active" ||
            row.tenant_lifecycle !== "active"
        ) {
            throw new ProjectAuthenticationError("credential_revoked", "The AppCredential is no longer active");
        }
        return row;
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
