import {
    AuditActor,
    AuditActorKind,
    ExpiringProjectAccessLifetime,
    hashSecret,
    INTERACTIVE_PROJECT_PERMISSIONS,
    PerpetualProjectAccessLifetime,
    PROJECT_PERMISSIONS,
    type ProjectAccessAuthorizer,
    ProjectAccessContext,
    type ProjectApplicationResolver,
    ProjectAuthenticationError,
    ProjectCredential,
    ProjectPermission,
    ProjectScope,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";
import type { StandaloneProjectAuthenticationStorage } from "./standalone-project-authentication-storage.ts";
import { STANDALONE_PROJECT_ID } from "./standalone-project-storage-directory.ts";

const STANDALONE_BROWSER_PERMISSIONS = Object.freeze([
    ...INTERACTIVE_PROJECT_PERMISSIONS,
    ProjectPermission.RuntimePair,
    ProjectPermission.RuntimeRevoke,
]);

function sanitizedActorReference(value: string): string {
    let sanitized = "";
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint > 31 && codePoint !== 127) {
            sanitized += character;
        }
    }
    return sanitized.replace(/\s+/g, " ").trim().slice(0, 200);
}

function matchingDigest(expected: string, received: string): boolean {
    if (expected.length !== received.length) {
        return false;
    }
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
        difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
    }
    return difference === 0;
}

export class StandaloneProjectAuthentication implements ProjectAccessAuthorizer, ProjectApplicationResolver {
    readonly #credentialHash: Promise<string>;
    readonly #storage: StandaloneProjectAuthenticationStorage;

    constructor(configuredCredential: string, storage: StandaloneProjectAuthenticationStorage) {
        this.#credentialHash = hashSecret(ProjectCredential.decode(configuredCredential).value);
        this.#storage = storage;
    }

    readonly resolveApplicationId: ProjectApplicationResolver["resolveApplicationId"] = async (projectId, signal) => {
        signal.throwIfAborted();
        if (validateIdentifier(projectId, "project_id") !== STANDALONE_PROJECT_ID) {
            throw new ProjectAuthenticationError("project_access_denied", "The Project is unavailable");
        }
        return "standalone";
    };

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
        const now = Date.now();
        const expectedHash = await this.#credentialHash;
        const receivedHash = await hashSecret(credential.value);
        signal.throwIfAborted();
        const owner = matchingDigest(expectedHash, receivedHash);
        const browser = owner
            ? null
            : await this.#storage.readBrowserCredential(STANDALONE_PROJECT_ID, receivedHash, signal);
        if (!owner && browser === null) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
        }
        if (browser !== null && browser.revokedAt !== null) {
            throw new ProjectAuthenticationError("credential_revoked", "The Project credential was revoked");
        }
        if (browser !== null && browser.expiresAt <= now) {
            throw new ProjectAuthenticationError("credential_expired", "The Project credential expired");
        }
        const permissions = new Set(owner ? PROJECT_PERMISSIONS : STANDALONE_BROWSER_PERMISSIONS);
        const actorId = owner ? "standalone-owner" : browser?.credentialId;
        if (actorId === undefined) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
        }
        const access = new ProjectAccessContext(
            new ProjectScope(STANDALONE_PROJECT_ID),
            permissions,
            new AuditActor(AuditActorKind.BrowserAccess, actorId),
            actorId,
            now,
            browser === null
                ? new PerpetualProjectAccessLifetime()
                : new ExpiringProjectAccessLifetime(browser.expiresAt),
        );
        if (!access.permits(requiredPermission)) {
            await this.#storage.recordAuthorization(
                {
                    actorId,
                    actorRef: sanitizedActorReference(_actorReference),
                    details: { permission: requiredPermission.value },
                    outcome: "denied",
                    projectId: STANDALONE_PROJECT_ID,
                    subjectId: actorId,
                },
                null,
                now,
                signal,
            );
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The Project credential does not grant this operation",
            );
        }
        await this.#storage.recordAuthorization(
            {
                actorId,
                actorRef: sanitizedActorReference(_actorReference),
                details: { permission: requiredPermission.value },
                outcome: "succeeded",
                projectId: STANDALONE_PROJECT_ID,
                subjectId: actorId,
            },
            browser?.credentialId ?? null,
            now,
            signal,
        );
        return access;
    };
}
