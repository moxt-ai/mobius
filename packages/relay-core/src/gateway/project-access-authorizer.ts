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
