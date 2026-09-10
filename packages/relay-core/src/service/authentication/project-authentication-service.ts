import type {
    ExternalIdentityAuthenticator,
    ExternalIdentityGrantResolver,
    IssuedProjectAccessCredential,
    ProjectAccessAuthorizer,
    ProjectAccessContext,
    ProjectAccessCredentialIssuer,
    ProjectApplicationCredentialAuthenticator,
    ProjectPermission,
    VerifiedExternalIdentity,
} from "../../entity/authentication/project-authentication.ts";

export interface ProjectAuthenticationService
    extends ProjectAccessAuthorizer,
        ProjectApplicationCredentialAuthenticator,
        ExternalIdentityGrantResolver,
        ProjectAccessCredentialIssuer {
    readonly exchangeExternalIdentity: (
        providerId: string,
        externalCredential: string,
        projectId: string,
        lifetimeMilliseconds: number,
        authenticator: ExternalIdentityAuthenticator,
        signal: AbortSignal,
    ) => Promise<IssuedProjectAccessCredential>;
    readonly createApplication: (
        access: ProjectAccessContext,
        name: string,
        permissions: ReadonlySet<ProjectPermission>,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly listApplications: (access: ProjectAccessContext, signal: AbortSignal) => Promise<object>;
    readonly issueApplicationCredential: (
        access: ProjectAccessContext,
        applicationId: string,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly rotateApplicationCredential: (
        access: ProjectAccessContext,
        credentialId: string,
        lifetimeMilliseconds: number,
        overlapMilliseconds: number,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly revokeApplicationCredential: (
        access: ProjectAccessContext,
        credentialId: string,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly revokeApplication: (
        access: ProjectAccessContext,
        applicationId: string,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly attachExternalIdentity: (
        access: ProjectAccessContext,
        identity: VerifiedExternalIdentity,
        permissions: ReadonlySet<ProjectPermission>,
        revokeOwnerCredential: boolean,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly listExternalIdentityBindings: (access: ProjectAccessContext, signal: AbortSignal) => Promise<object>;
    readonly revokeExternalIdentityBinding: (
        access: ProjectAccessContext,
        bindingId: string,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly listOwnerCredentials: (access: ProjectAccessContext, signal: AbortSignal) => Promise<object>;
    readonly rotateOwnerCredential: (
        access: ProjectAccessContext,
        credentialId: string,
        overlapMilliseconds: number,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly revokeOwnerCredential: (
        access: ProjectAccessContext,
        credentialId: string,
        signal: AbortSignal,
    ) => Promise<object>;
    readonly listAuditEvents: (access: ProjectAccessContext, limit: number, signal: AbortSignal) => Promise<object>;
}
