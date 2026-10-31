import type { ProjectAccessContext, ProjectPermission } from "../entity/authentication/project-authentication.ts";

/** The host authenticates an opaque credential and authorizes a resolved Project. */
export interface ProjectAccessAuthorizer {
    readonly authorizeProject: (
        projectId: string,
        credentialValue: string,
        requiredPermission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ) => Promise<ProjectAccessContext>;
}

/**
 * The host's current answer for a project credential that opened a long-lived connection. It applies the same rule
 * as `ProjectAccessAuthorizer`, so revoking, rotating or descoping the credential ends what the connection may do.
 */
export interface ProjectCredentialAuthority {
    readonly grants: (
        projectId: string,
        credentialId: string,
        requiredPermissions: readonly ProjectPermission[],
        signal: AbortSignal,
    ) => Promise<boolean>;
}
