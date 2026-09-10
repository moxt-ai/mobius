import type { ProjectScope } from "../do/session.ts";
import { VerifiedChannelAccess } from "../pairing/pairing.ts";

export class ProjectPermission {
    static readonly ApplicationsManage = new ProjectPermission("application:manage");
    static readonly ArtifactRead = new ProjectPermission("artifact:read");
    static readonly ArtifactWrite = new ProjectPermission("artifact:write");
    static readonly BotBehaviorWrite = new ProjectPermission("bot:behavior:write");
    static readonly BotBindingWrite = new ProjectPermission("bot:binding:write");
    static readonly BotConnectionManage = new ProjectPermission("bot:connection:manage");
    static readonly BotProfileWrite = new ProjectPermission("bot:profile:write");
    static readonly BotRead = new ProjectPermission("bot:read");
    static readonly ConversationCreate = new ProjectPermission("conversation:create");
    static readonly ConversationRead = new ProjectPermission("conversation:read");
    static readonly ConversationTurnCancel = new ProjectPermission("conversation:turn:cancel");
    static readonly ConversationTurnCreate = new ProjectPermission("conversation:turn:create");
    static readonly IdentityBindingsManage = new ProjectPermission("identity-binding:manage");
    static readonly InteractionRespond = new ProjectPermission("interaction:respond");
    static readonly OwnerCredentialsManage = new ProjectPermission("owner-credential:manage");
    static readonly ProjectEventsRead = new ProjectPermission("project:event:read");
    static readonly ProjectRead = new ProjectPermission("project:read");
    static readonly RuntimePair = new ProjectPermission("runtime:pair");
    static readonly RuntimeRead = new ProjectPermission("runtime:read");
    static readonly RuntimeRevoke = new ProjectPermission("runtime:revoke");
    static readonly SessionDelete = new ProjectPermission("session:delete");
    static readonly SessionRead = new ProjectPermission("session:read");
    static readonly SessionWrite = new ProjectPermission("session:write");

    readonly value: string;

    private constructor(value: string) {
        this.value = value;
    }

    readonly toJSON = (): string => this.value;
}

export const PROJECT_PERMISSIONS: readonly ProjectPermission[] = Object.freeze([
    ProjectPermission.ApplicationsManage,
    ProjectPermission.ArtifactRead,
    ProjectPermission.ArtifactWrite,
    ProjectPermission.BotBehaviorWrite,
    ProjectPermission.BotBindingWrite,
    ProjectPermission.BotConnectionManage,
    ProjectPermission.BotProfileWrite,
    ProjectPermission.BotRead,
    ProjectPermission.ConversationCreate,
    ProjectPermission.ConversationRead,
    ProjectPermission.ConversationTurnCancel,
    ProjectPermission.ConversationTurnCreate,
    ProjectPermission.IdentityBindingsManage,
    ProjectPermission.InteractionRespond,
    ProjectPermission.OwnerCredentialsManage,
    ProjectPermission.ProjectEventsRead,
    ProjectPermission.ProjectRead,
    ProjectPermission.RuntimePair,
    ProjectPermission.RuntimeRead,
    ProjectPermission.RuntimeRevoke,
    ProjectPermission.SessionDelete,
    ProjectPermission.SessionRead,
    ProjectPermission.SessionWrite,
]);

export const INTERACTIVE_PROJECT_PERMISSIONS: readonly ProjectPermission[] = Object.freeze([
    ProjectPermission.ArtifactRead,
    ProjectPermission.ArtifactWrite,
    ProjectPermission.BotRead,
    ProjectPermission.ConversationCreate,
    ProjectPermission.ConversationRead,
    ProjectPermission.ConversationTurnCancel,
    ProjectPermission.ConversationTurnCreate,
    ProjectPermission.InteractionRespond,
    ProjectPermission.ProjectEventsRead,
    ProjectPermission.ProjectRead,
    ProjectPermission.RuntimeRead,
    ProjectPermission.SessionDelete,
    ProjectPermission.SessionRead,
    ProjectPermission.SessionWrite,
]);

export function decodeProjectPermission(value: unknown): ProjectPermission {
    if (typeof value !== "string") {
        throw new ProjectAuthenticationError("project_permission_invalid", "The Project permission is invalid");
    }
    const permission = PROJECT_PERMISSIONS.find((candidate) => candidate.value === value);
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

export class AuditActorKind {
    static readonly AccountlessOwner = new AuditActorKind("accountless_owner");
    static readonly Application = new AuditActorKind("application");
    static readonly BotConnection = new AuditActorKind("bot_connection");
    static readonly BrowserAccess = new AuditActorKind("browser_access");
    static readonly ExternalIdentity = new AuditActorKind("external_identity");

    readonly value: string;

    private constructor(value: string) {
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

    get tenantId(): string {
        return this.scope.tenantId;
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

export const ProjectCredentialScheme = Object.freeze({
    Access: "mobius_access",
    Application: "project_application",
    Capability: "project_capability",
});

export class ProjectCredential {
    readonly publicCredentialId: string;
    readonly scheme: string;
    readonly value: string;

    private constructor(scheme: string, value: string, publicCredentialId: string) {
        this.scheme = scheme;
        this.value = value;
        this.publicCredentialId = publicCredentialId;
    }

    static readonly decode = (value: unknown): ProjectCredential => {
        if (typeof value !== "string") {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
        }
        const application = APPLICATION_CREDENTIAL_PATTERN.exec(value);
        if (application !== null) {
            return new ProjectCredential(ProjectCredentialScheme.Application, value, application[1] ?? "");
        }
        const access = ACCESS_CREDENTIAL_PATTERN.exec(value);
        if (access !== null) {
            return new ProjectCredential(ProjectCredentialScheme.Access, value, access[1] ?? "");
        }
        if (CAPABILITY_CREDENTIAL_PATTERN.test(value)) {
            return new ProjectCredential(ProjectCredentialScheme.Capability, value, "");
        }
        throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
    };
}

const APPLICATION_CREDENTIAL_PATTERN = /^mapp_([a-zA-Z0-9_-]{22})_([a-zA-Z0-9_-]{43})$/;
const ACCESS_CREDENTIAL_PATTERN = /^maccess_([a-zA-Z0-9_-]{22})_([a-zA-Z0-9_-]{43})$/;
const CAPABILITY_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

export function decodeProjectCredential(value: unknown): ProjectCredential {
    return ProjectCredential.decode(value);
}

export class ProjectAuthenticationError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ProjectAuthenticationError";
    }
}

export class VerifiedExternalIdentity {
    readonly authenticatedAtEpochMilliseconds: number;
    readonly expiresAtEpochMilliseconds: number;
    readonly issuer: string;
    readonly metadata: ReadonlyMap<string, string>;
    readonly providerId: string;
    readonly subject: string;

    constructor(
        providerId: string,
        issuer: string,
        subject: string,
        metadata: ReadonlyMap<string, string>,
        authenticatedAtEpochMilliseconds: number,
        expiresAtEpochMilliseconds: number,
    ) {
        if (
            !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(providerId) ||
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
        this.authenticatedAtEpochMilliseconds = authenticatedAtEpochMilliseconds;
        this.expiresAtEpochMilliseconds = expiresAtEpochMilliseconds;
    }
}

export class ExternalIdentityCredential {
    readonly credential: string;
    readonly providerId: string;

    constructor(providerId: string, credential: string) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(providerId)) {
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

export interface ProjectApplicationCredentialAuthenticator {
    readonly authenticate: (
        credential: ProjectCredential,
        requiredPermission: ProjectPermission,
        signal: AbortSignal,
    ) => Promise<ProjectAccessContext>;
}

export interface ProjectAccessCredentialIssuer {
    readonly issue: (
        identity: VerifiedExternalIdentity,
        grant: ExternalIdentityProjectGrant,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ) => Promise<IssuedProjectAccessCredential>;
}

export interface ProjectAccessAuthorizer {
    readonly authorize: (
        credential: ProjectCredential,
        requiredPermission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ) => Promise<ProjectAccessContext>;
    readonly authorizeProject: (
        projectId: string,
        credentialValue: string,
        requiredPermission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ) => Promise<ProjectAccessContext>;
}

export class RegisteredExternalIdentityAuthenticator {
    readonly authenticator: ExternalIdentityAuthenticator;
    readonly providerId: string;

    constructor(providerId: string, authenticator: ExternalIdentityAuthenticator) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(providerId)) {
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
    readonly leaseId: string;
    readonly scope: ProjectScope;

    constructor(scope: ProjectScope, runtimeId: string, channelId: string, credentialId: string, leaseId: string) {
        super(channelId, runtimeId, scope.tenantId, scope.projectId);
        this.scope = scope;
        this.credentialId = credentialId;
        this.leaseId = leaseId;
    }
}

export class BotConnectionAccessContext {
    readonly audience: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly connectorActor: AuditActor;
    readonly credentialId: string;
    readonly scope: ProjectScope;
    readonly scopes: ReadonlySet<string>;

    constructor(
        scope: ProjectScope,
        botId: string,
        connectionId: string,
        credentialId: string,
        connectorActor: AuditActor,
        audience: string,
        scopes: ReadonlySet<string>,
    ) {
        this.scope = scope;
        this.botId = botId;
        this.connectionId = connectionId;
        this.credentialId = credentialId;
        this.connectorActor = connectorActor;
        this.audience = audience;
        this.scopes = new Set(scopes);
    }
}

export class ExecutionPermit {
    readonly allowedTargetIds: ReadonlySet<string>;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly capabilityId: string;
    readonly conversationId: string;
    readonly executionId: string;
    readonly expiresAtEpochMilliseconds: number;
    readonly operation: string;
    readonly remainingUses: number;
    readonly runtimeId: string;
    readonly scope: ProjectScope;
    readonly sessionId: string;
    readonly turnId: string;

    constructor(
        scope: ProjectScope,
        capabilityId: string,
        executionId: string,
        botId: string,
        conversationId: string,
        sessionId: string,
        turnId: string,
        behaviorRevisionId: string,
        bindingId: string,
        bindingRevision: number,
        runtimeId: string,
        operation: string,
        allowedTargetIds: ReadonlySet<string>,
        expiresAtEpochMilliseconds: number,
        remainingUses: number,
    ) {
        this.scope = scope;
        this.capabilityId = capabilityId;
        this.executionId = executionId;
        this.botId = botId;
        this.conversationId = conversationId;
        this.sessionId = sessionId;
        this.turnId = turnId;
        this.behaviorRevisionId = behaviorRevisionId;
        this.bindingId = bindingId;
        this.bindingRevision = bindingRevision;
        this.runtimeId = runtimeId;
        this.operation = operation;
        this.allowedTargetIds = new Set(allowedTargetIds);
        this.expiresAtEpochMilliseconds = expiresAtEpochMilliseconds;
        this.remainingUses = remainingUses;
    }
}
