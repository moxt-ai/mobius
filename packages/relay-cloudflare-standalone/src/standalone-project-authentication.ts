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
import type { StandaloneProjectStorage } from "./storage/standalone-project-storage.ts";

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
    readonly #projects: StandaloneProjectStorage;
    readonly #storage: StandaloneProjectAuthenticationStorage;

    constructor(
        configuredCredential: string,
        projects: StandaloneProjectStorage,
        storage: StandaloneProjectAuthenticationStorage,
    ) {
        this.#credentialHash = hashSecret(ProjectCredential.decode(configuredCredential).value);
        this.#projects = projects;
        this.#storage = storage;
    }

    readonly resolveApplicationId: ProjectApplicationResolver["resolveApplicationId"] = async (projectId, signal) => {
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        if ((await this.#projects.read(normalizedProjectId, signal)) === null) {
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
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        const project = await this.#projects.read(normalizedProjectId, signal);
        if (project === null) {
            throw new ProjectAuthenticationError("project_access_denied", "The Project is unavailable");
        }
        const credential = ProjectCredential.decode(credentialValue);
        const now = Date.now();
        const deploymentHash = await this.#credentialHash;
        const receivedHash = await hashSecret(credential.value);
        signal.throwIfAborted();
        const deploymentOwner = matchingDigest(deploymentHash, receivedHash);
        const projectOwner = matchingDigest(project.ownerTokenHash, receivedHash);
        const owner = deploymentOwner || projectOwner;
        const browser = owner
            ? null
            : await this.#storage.readBrowserCredential(normalizedProjectId, receivedHash, signal);
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
        const actorId = deploymentOwner
            ? "standalone-owner"
            : projectOwner
              ? normalizedProjectId
              : browser?.credentialId;
        if (actorId === undefined) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
        }
        const access = new ProjectAccessContext(
            new ProjectScope(normalizedProjectId),
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
                    projectId: normalizedProjectId,
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
                projectId: normalizedProjectId,
                subjectId: actorId,
            },
            browser?.credentialId ?? null,
            now,
            signal,
        );
        return access;
    };
}
