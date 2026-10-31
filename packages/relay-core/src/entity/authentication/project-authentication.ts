import { isIdentifier, PROJECT_PERMISSION_NAMES, type ProjectPermissionName } from "@moxt-ai/mobius-sdk/protocol";
import type { ProjectScope } from "../do/session.ts";
import type { HttpError } from "../http-error.ts";
import { VerifiedChannelAccess } from "../pairing/pairing.ts";

export class ProjectPermission {
    // The vocabulary is defined once by the protocol; each name has exactly one instance.
    static readonly #byName: ReadonlyMap<string, ProjectPermission> = new Map(
        PROJECT_PERMISSION_NAMES.map((name) => [name, new ProjectPermission(name)]),
    );

    /** The permission this release knows by that name, if any. */
    static readonly known = (name: string): ProjectPermission | undefined => ProjectPermission.#byName.get(name);

    static readonly named = (name: ProjectPermissionName): ProjectPermission => {
        const permission = ProjectPermission.#byName.get(name);
        if (permission === undefined) {
            throw new Error(`Project permission ${name} is missing from the vocabulary`);
        }
        return permission;
    };

    static readonly ArtifactRead = ProjectPermission.named("artifact:read");
    static readonly ArtifactWrite = ProjectPermission.named("artifact:write");
    static readonly IdentityBindingsManage = ProjectPermission.named("identity-binding:manage");
    static readonly InteractionRespond = ProjectPermission.named("interaction:respond");
    static readonly OwnerCredentialsManage = ProjectPermission.named("owner-credential:manage");
    static readonly ProjectEventsRead = ProjectPermission.named("project:event:read");
    static readonly ProjectRead = ProjectPermission.named("project:read");
    static readonly RuntimePair = ProjectPermission.named("runtime:pair");
    static readonly RuntimeRead = ProjectPermission.named("runtime:read");
    static readonly RuntimeRevoke = ProjectPermission.named("runtime:revoke");
    static readonly SessionDelete = ProjectPermission.named("session:delete");
    static readonly SessionRead = ProjectPermission.named("session:read");
    static readonly SessionWrite = ProjectPermission.named("session:write");

    readonly value: ProjectPermissionName;

    private constructor(value: ProjectPermissionName) {
        this.value = value;
    }

    readonly toJSON = (): string => this.value;
}

/**
 * What a project credential must grant to open a Runtime host connection and to keep using it. The connection
 * receives the Runtime's status and every Session's traffic, so it needs to read both. Each command the connection
 * sends additionally needs that command's own permission.
 */
export const PROJECT_HOST_PERMISSIONS: readonly ProjectPermission[] = Object.freeze([
    ProjectPermission.RuntimeRead,
    ProjectPermission.SessionRead,
]);

export const PROJECT_PERMISSIONS: readonly ProjectPermission[] = Object.freeze(
    PROJECT_PERMISSION_NAMES.map(ProjectPermission.named),
);

export const INTERACTIVE_PROJECT_PERMISSIONS: readonly ProjectPermission[] = Object.freeze([
    ProjectPermission.ArtifactRead,
    ProjectPermission.ArtifactWrite,
    ProjectPermission.InteractionRespond,
    ProjectPermission.ProjectEventsRead,
    ProjectPermission.ProjectRead,
    ProjectPermission.RuntimeRead,
    ProjectPermission.SessionDelete,
    ProjectPermission.SessionRead,
    ProjectPermission.SessionWrite,
]);

/** Decodes a requested permission strictly: a name this release does not know is an invalid request. */
export function decodeProjectPermission(value: unknown): ProjectPermission {
    if (typeof value !== "string") {
        throw new ProjectAuthenticationError("project_permission_invalid", "The Project permission is invalid");
    }
    const permission = ProjectPermission.known(value);
    if (permission === undefined) {
        throw new ProjectAuthenticationError("project_permission_invalid", "The Project permission is invalid");
    }
    return permission;
}

export function decodeProjectPermissions(value: unknown): ReadonlySet<ProjectPermission> {
    if (!Array.isArray(value) || value.length === 0 || value.length > PROJECT_PERMISSIONS.length) {
        throw new ProjectAuthenticationError("project_permission_invalid", "The Project permissions are invalid");
    }
    const permissions = new Set<ProjectPermission>();
    for (const candidate of value) {
        const permission = decodeProjectPermission(candidate);
        if (permissions.has(permission)) {
            throw new ProjectAuthenticationError("project_permission_invalid", "A Project permission is duplicated");
        }
        permissions.add(permission);
    }
    return permissions;
}

const MAXIMUM_RECORDED_PERMISSIONS = 64;
const MAXIMUM_RECORDED_PERMISSION_LENGTH = 128;

/** A stored permission set as this release reads it. */
export class RecordedProjectPermissions {
    readonly granted: ReadonlySet<ProjectPermission>;
    /** Names a newer release recorded that this release does not know. They grant nothing here. */
    readonly unrecognized: readonly string[];

    constructor(granted: ReadonlySet<ProjectPermission>, unrecognized: readonly string[] = []) {
        this.granted = new Set(granted);
        this.unrecognized = Object.freeze([...unrecognized]);
    }

    /** Every recorded name, so rewriting the record keeps what a newer release granted. */
    readonly names = (): readonly string[] =>
        Object.freeze([...[...this.granted].map((permission) => permission.value), ...this.unrecognized].sort());
}

/**
 * Decodes a stored permission set, which a newer release may have written during a gradual deployment or before a
 * rollback. Names this release does not know are set aside instead of invalidating the record; a value that is not a
 * set of permission names still fails.
 */
export function decodeRecordedProjectPermissions(value: unknown): RecordedProjectPermissions {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_RECORDED_PERMISSIONS) {
        throw recordedPermissionsInvalid();
    }
    const entries: readonly unknown[] = value;
    const names = new Set<string>();
    for (const candidate of entries) {
        if (
            typeof candidate !== "string" ||
            candidate.length === 0 ||
            candidate.length > MAXIMUM_RECORDED_PERMISSION_LENGTH ||
            names.has(candidate)
        ) {
            throw recordedPermissionsInvalid();
        }
        names.add(candidate);
    }
    const granted = new Set<ProjectPermission>();
    const unrecognized: string[] = [];
    for (const name of names) {
        const permission = ProjectPermission.known(name);
        if (permission === undefined) {
            unrecognized.push(name);
        } else {
            granted.add(permission);
        }
    }
    return new RecordedProjectPermissions(granted, unrecognized);
}

function recordedPermissionsInvalid(): ProjectAuthenticationError {
    return new ProjectAuthenticationError(
        "project_authorization_record_invalid",
        "The stored Project permissions are invalid",
    );
}

export class AuditActorKind {
    static readonly BrowserAccess = new AuditActorKind("browser_access");
    static readonly ExternalIdentity = new AuditActorKind("external_identity");

    readonly value: string;

    protected constructor(value: string) {
        this.value = value;
    }

    readonly toJSON = (): string => this.value;
}

export class AuditActor {
    readonly actorId: string;
    readonly kind: AuditActorKind;

    constructor(kind: AuditActorKind, actorId: string) {
        this.kind = kind;
        this.actorId = actorId;
    }
}

export abstract class ProjectAccessLifetime {
    abstract readonly expiresAtEpochMilliseconds: number;
    abstract readonly isExpiring: boolean;
}

export class PerpetualProjectAccessLifetime extends ProjectAccessLifetime {
    readonly expiresAtEpochMilliseconds = Number.MAX_SAFE_INTEGER;
    readonly isExpiring = false;
}

export class ExpiringProjectAccessLifetime extends ProjectAccessLifetime {
    readonly expiresAtEpochMilliseconds: number;
    readonly isExpiring = true;

    constructor(expiresAtEpochMilliseconds: number) {
        super();
        this.expiresAtEpochMilliseconds = expiresAtEpochMilliseconds;
    }
}

export class ProjectAccessContext {
    readonly actor: AuditActor;
    readonly authenticatedAtEpochMilliseconds: number;
    readonly credentialId: string;
    readonly lifetime: ProjectAccessLifetime;
    readonly permissions: ReadonlySet<ProjectPermission>;
    readonly scope: ProjectScope;

    get projectId(): string {
        return this.scope.projectId;
    }

    constructor(
        scope: ProjectScope,
        permissions: ReadonlySet<ProjectPermission>,
        actor: AuditActor,
        credentialId: string,
        authenticatedAtEpochMilliseconds: number,
        lifetime: ProjectAccessLifetime,
    ) {
        this.scope = scope;
        this.permissions = new Set(permissions);
        this.actor = actor;
        this.credentialId = credentialId;
        this.authenticatedAtEpochMilliseconds = authenticatedAtEpochMilliseconds;
        this.lifetime = lifetime;
    }

    readonly permits = (permission: ProjectPermission): boolean => this.permissions.has(permission);
}

export class ProjectCredential {
    readonly value: string;

    private constructor(value: string) {
        this.value = value;
    }

    static readonly decode = (value: unknown): ProjectCredential => {
        if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{32,256}$/.test(value)) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
        }
        return new ProjectCredential(value);
    };
}

export function decodeProjectCredential(value: unknown): ProjectCredential {
    return ProjectCredential.decode(value);
}

export class ProjectAuthenticationError extends Error implements HttpError {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ProjectAuthenticationError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: projectAuthenticationErrorStatus(this.code),
    });
}

function projectAuthenticationErrorStatus(code: string): number {
    switch (code) {
        case "credential_expired":
        case "credential_revoked":
        case "external_algorithm_invalid":
        case "external_audience_invalid":
        case "external_claims_invalid":
        case "external_credential_invalid":
        case "external_identity_expired":
        case "external_identity_invalid":
        case "external_identity_not_active":
        case "external_issuer_invalid":
        case "external_provider_invalid":
        case "external_signature_invalid":
        case "external_signing_key_unknown":
        case "external_subject_invalid":
        case "project_credential_invalid":
            return 401;
        case "external_identity_not_granted":
        case "owner_access_required":
        case "project_access_denied":
        case "project_permission_denied":
            return 403;
        case "external_identity_binding_not_found":
        case "external_provider_unknown":
        case "owner_credential_not_found":
            return 404;
        case "external_identity_binding_conflict":
        case "owner_credential_rotation_conflict":
            return 409;
        case "access_credential_lifetime_invalid":
        case "audit_page_invalid":
        case "credential_overlap_invalid":
        case "external_identity_not_fresh":
        case "project_permission_invalid":
            return 400;
        case "external_provider_timeout":
            return 504;
        default:
            return 503;
    }
}

export class VerifiedExternalIdentity {
    readonly authenticatedAtEpochMilliseconds: number;
    readonly expiresAtEpochMilliseconds: number;
    readonly issuer: string;
    readonly metadata: ReadonlyMap<string, string>;
    readonly organization:
        | { readonly kind: "none" }
        | { readonly kind: "organization"; readonly id: string; readonly role: string };
    readonly providerId: string;
    readonly subject: string;

    constructor(
        providerId: string,
        issuer: string,
        subject: string,
        metadata: ReadonlyMap<string, string>,
        authenticatedAtEpochMilliseconds: number,
        expiresAtEpochMilliseconds: number,
        organization: VerifiedExternalIdentity["organization"] = { kind: "none" },
    ) {
        if (
            !isIdentifier(providerId) ||
            issuer.length === 0 ||
            issuer.length > 2_048 ||
            subject.length === 0 ||
            subject.length > 256 ||
            !Number.isSafeInteger(authenticatedAtEpochMilliseconds) ||
            authenticatedAtEpochMilliseconds < 0 ||
            !Number.isSafeInteger(expiresAtEpochMilliseconds) ||
            expiresAtEpochMilliseconds <= authenticatedAtEpochMilliseconds ||
            metadata.size > 32
        ) {
            throw new ProjectAuthenticationError(
                "external_identity_invalid",
                "The verified external identity is invalid",
            );
        }
        for (const [name, value] of metadata) {
            if (
                typeof name !== "string" ||
                !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(name) ||
                typeof value !== "string" ||
                value.length > 500
            ) {
                throw new ProjectAuthenticationError(
                    "external_identity_invalid",
                    "The verified external identity metadata is invalid",
                );
            }
        }
        this.providerId = providerId;
        this.issuer = issuer;
        this.subject = subject;
        this.metadata = new Map(metadata);
        if (
            organization.kind === "organization" &&
            (!/^org_[a-zA-Z0-9]+$/.test(organization.id) ||
                organization.id.length > 128 ||
                !/^org:[a-zA-Z0-9_-]+$/.test(organization.role))
        ) {
            throw new ProjectAuthenticationError("external_identity_invalid", "The verified organization is invalid");
        }
        this.organization = Object.freeze({ ...organization });
        this.authenticatedAtEpochMilliseconds = authenticatedAtEpochMilliseconds;
        this.expiresAtEpochMilliseconds = expiresAtEpochMilliseconds;
    }
}

export class ExternalIdentityCredential {
    readonly credential: string;
    readonly providerId: string;

    constructor(providerId: string, credential: string) {
        if (!isIdentifier(providerId)) {
            throw new ProjectAuthenticationError("external_provider_invalid", "The external provider is invalid");
        }
        if (credential.length === 0 || credential.length > 16 * 1_024 || hasControlCharacters(credential)) {
            throw new ProjectAuthenticationError("external_identity_invalid", "The external credential is invalid");
        }
        this.providerId = providerId;
        this.credential = credential;
    }
}

function hasControlCharacters(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 31 || codePoint === 127) {
            return true;
        }
    }
    return false;
}

export class ExternalIdentityProjectGrant {
    readonly bindingId: string;
    readonly grantId: string;
    readonly permissions: ReadonlySet<ProjectPermission>;
    readonly scope: ProjectScope;

    constructor(bindingId: string, grantId: string, scope: ProjectScope, permissions: ReadonlySet<ProjectPermission>) {
        this.bindingId = bindingId;
        this.grantId = grantId;
        this.scope = scope;
        this.permissions = new Set(permissions);
    }
}

export class IssuedProjectAccessCredential {
    readonly credential: string;
    readonly credentialId: string;
    readonly expiresAtEpochMilliseconds: number;
    readonly permissions: ReadonlySet<ProjectPermission>;
    readonly scope: ProjectScope;

    constructor(
        credential: string,
        credentialId: string,
        scope: ProjectScope,
        permissions: ReadonlySet<ProjectPermission>,
        expiresAtEpochMilliseconds: number,
    ) {
        this.credential = credential;
        this.credentialId = credentialId;
        this.scope = scope;
        this.permissions = new Set(permissions);
        this.expiresAtEpochMilliseconds = expiresAtEpochMilliseconds;
    }
}

export interface ExternalIdentityAuthenticator {
    readonly authenticate: (
        credential: ExternalIdentityCredential,
        signal: AbortSignal,
    ) => Promise<VerifiedExternalIdentity>;
}

export interface ExternalIdentityGrantResolver {
    readonly resolve: (
        identity: VerifiedExternalIdentity,
        signal: AbortSignal,
    ) => Promise<readonly ExternalIdentityProjectGrant[]>;
}

export interface ProjectAccessCredentialIssuer {
    readonly issue: (
        identity: VerifiedExternalIdentity,
        grant: ExternalIdentityProjectGrant,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ) => Promise<IssuedProjectAccessCredential>;
}

export class RegisteredExternalIdentityAuthenticator {
    readonly authenticator: ExternalIdentityAuthenticator;
    readonly providerId: string;

    constructor(providerId: string, authenticator: ExternalIdentityAuthenticator) {
        if (!isIdentifier(providerId)) {
            throw new ProjectAuthenticationError(
                "external_provider_configuration_invalid",
                "The external identity provider identifier is invalid",
            );
        }
        this.providerId = providerId;
        this.authenticator = authenticator;
    }
}

export class ExternalIdentityAuthenticatorRegistry implements ExternalIdentityAuthenticator {
    readonly #authenticators = new Map<string, ExternalIdentityAuthenticator>();

    constructor(registrations: readonly RegisteredExternalIdentityAuthenticator[]) {
        for (const registration of registrations) {
            if (this.#authenticators.has(registration.providerId)) {
                throw new ProjectAuthenticationError(
                    "external_provider_configuration_invalid",
                    "An external identity provider is registered more than once",
                );
            }
            this.#authenticators.set(registration.providerId, registration.authenticator);
        }
    }

    readonly authenticate = async (
        credential: ExternalIdentityCredential,
        signal: AbortSignal,
    ): Promise<VerifiedExternalIdentity> => {
        signal.throwIfAborted();
        const authenticator = this.#authenticators.get(credential.providerId);
        if (authenticator === undefined) {
            throw new ProjectAuthenticationError(
                "external_provider_unknown",
                "The external identity provider is not configured",
            );
        }
        return await authenticator.authenticate(credential, signal);
    };
}

export class RuntimeAccessContext extends VerifiedChannelAccess {
    readonly credentialId: string;
    readonly scope: ProjectScope;

    constructor(scope: ProjectScope, runtimeId: string, channelId: string, credentialId: string) {
        super(channelId, runtimeId, scope.projectId, []);
        this.scope = scope;
        this.credentialId = credentialId;
    }
}
