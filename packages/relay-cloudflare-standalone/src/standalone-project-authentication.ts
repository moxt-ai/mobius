import {
    AuditActor,
    AuditActorKind,
    hashSecret,
    PerpetualProjectAccessLifetime,
    PROJECT_PERMISSIONS,
    type ProjectAccessAuthorizer,
    ProjectAccessContext,
    ProjectAuthenticationError,
    ProjectCredential,
    ProjectScope,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";
import { STANDALONE_PROJECT_ID } from "./standalone-project-storage-directory.ts";

export class StandaloneProjectAuthentication implements ProjectAccessAuthorizer {
    readonly #credentialHash: Promise<string>;

    constructor(configuredCredential: string) {
        this.#credentialHash = hashSecret(ProjectCredential.decode(configuredCredential).value);
    }

    readonly authorizeProject: ProjectAccessAuthorizer["authorizeProject"] = async (
        projectId,
        credentialValue,
        requiredPermission,
        _actorReference,
        signal,
    ) => {
        signal.throwIfAborted();
        if (validateIdentifier(projectId, "project_id") !== STANDALONE_PROJECT_ID) {
            throw new ProjectAuthenticationError(
                "project_access_denied",
                "The credential is not authorized for this Project",
            );
        }
        const credential = ProjectCredential.decode(credentialValue);
        const expectedHash = await this.#credentialHash;
        const receivedHash = await hashSecret(credential.value);
        signal.throwIfAborted();
        let difference = 0;
        for (let index = 0; index < expectedHash.length; index += 1) {
            difference |= expectedHash.charCodeAt(index) ^ receivedHash.charCodeAt(index);
        }
        if (difference !== 0) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
        }
        const access = new ProjectAccessContext(
            new ProjectScope(STANDALONE_PROJECT_ID),
            new Set(PROJECT_PERMISSIONS),
            new AuditActor(AuditActorKind.BrowserAccess, "standalone-owner"),
            "standalone-owner",
            Date.now(),
            new PerpetualProjectAccessLifetime(),
        );
        if (!access.permits(requiredPermission)) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The Project credential does not grant this operation",
            );
        }
        return access;
    };
}
