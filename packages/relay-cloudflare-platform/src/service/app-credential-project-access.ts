import {
    AuditActor,
    PerpetualProjectAccessLifetime,
    ProjectAccessContext,
    ProjectAuthenticationError,
    type ProjectCredentialAuthority,
    type ProjectPermission,
    ProjectScope,
} from "@moxt-ai/mobius-relay-core";
import { PlatformAuditActorKind } from "../entity/platform-control-plane.ts";
import type { CredentialRow } from "../entity/platform-records.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";
import { appCredentialActive, credentialPermissions } from "./app-credential-authentication-service.ts";

/**
 * What an authenticated AppCredential may do in a Project. Requests apply it once; a connection the credential
 * opened applies it again for every message, so both observe a revocation, rotation or Project deletion.
 */
export class AppCredentialProjectAccess implements ProjectCredentialAuthority {
    readonly #storage: Pick<
        PlatformControlPlaneStorage,
        "readActiveProjectScope" | "readCredentialById" | "scopedProjects"
    >;

    constructor(
        storage: Pick<PlatformControlPlaneStorage, "readActiveProjectScope" | "readCredentialById" | "scopedProjects">,
    ) {
        this.#storage = storage;
    }

    readonly authorize = async (
        row: CredentialRow,
        projectId: string,
        requiredPermissions: readonly ProjectPermission[],
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const project = await this.#storage.readActiveProjectScope(projectId, signal);
        if (project === null || project.app_id !== row.app_id) {
            throw new ProjectAuthenticationError(
                "project_access_denied",
                "The AppCredential is not authorized for this Project",
            );
        }
        if (row.all_projects !== 1) {
            const hasProject =
                (await this.#storage.scopedProjects(row.credential_id, [projectId], signal)).length === 1;
            if (!hasProject) {
                throw new ProjectAuthenticationError(
                    "project_access_denied",
                    "The AppCredential is not authorized for this Project",
                );
            }
        }
        const granted = credentialPermissions(row).granted;
        if (!requiredPermissions.every((permission) => granted.has(permission))) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The AppCredential does not grant this Project permission",
            );
        }
        return new ProjectAccessContext(
            new ProjectScope(project.project_id),
            granted,
            new AuditActor(PlatformAuditActorKind.Application, row.app_id),
            row.credential_id,
            Date.now(),
            new PerpetualProjectAccessLifetime(),
        );
    };

    readonly grants: ProjectCredentialAuthority["grants"] = async (
        projectId,
        credentialId,
        requiredPermissions,
        signal,
    ) => {
        const row = await this.#storage.readCredentialById(credentialId, signal);
        if (row === null || !appCredentialActive(row, Date.now())) {
            return false;
        }
        try {
            await this.authorize(row, projectId, requiredPermissions, signal);
            return true;
        } catch (cause) {
            if (cause instanceof ProjectAuthenticationError) {
                return false;
            }
            throw cause;
        }
    };
}
