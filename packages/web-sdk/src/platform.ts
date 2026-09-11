import { MobiusProtocolError, MobiusValidationError } from "./errors.ts";
import { type MobiusEndpointOptions, MobiusRequestExecutor, StaticMobiusCredentialProvider } from "./service-client.ts";

export { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";

export {
    MobiusApiError,
    MobiusCancellationError,
    MobiusConnectionError,
    MobiusError,
    MobiusProtocolError,
    MobiusTimeoutError,
    MobiusValidationError,
} from "./errors.ts";
export type { MobiusCredentialProvider, MobiusHttpTransport } from "./service-client.ts";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const APP_CREDENTIAL_PATTERN = /^mapp_[a-zA-Z0-9_-]{22}_[a-zA-Z0-9_-]{43}$/;
const CONVERSATION_CREDENTIAL_PATTERN = /^mconv_[a-zA-Z0-9_-]{22}_[a-zA-Z0-9_-]{43}$/;

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new MobiusProtocolError(`The Platform returned an invalid ${name}`);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function string(value: Readonly<Record<string, unknown>>, field: string, maximum = 16_384): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length > maximum) {
        throw new MobiusProtocolError(`The Platform returned an invalid ${field}`);
    }
    return candidate;
}

function identifier(value: Readonly<Record<string, unknown>>, field: string): string {
    const candidate = string(value, field, 128);
    if (!IDENTIFIER_PATTERN.test(candidate)) {
        throw new MobiusProtocolError(`The Platform returned an invalid ${field}`);
    }
    return candidate;
}

function timestamp(value: Readonly<Record<string, unknown>>, field: string): string {
    const candidate = string(value, field, 128);
    if (candidate.length > 0 && Number.isNaN(Date.parse(candidate))) {
        throw new MobiusProtocolError(`The Platform returned an invalid ${field}`);
    }
    return candidate;
}

function integer(value: Readonly<Record<string, unknown>>, field: string): number {
    const candidate = value[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw new MobiusProtocolError(`The Platform returned an invalid ${field}`);
    }
    return candidate;
}

function strings(value: Readonly<Record<string, unknown>>, field: string): readonly string[] {
    const candidate = value[field];
    if (!Array.isArray(candidate) || candidate.length > 100 || candidate.some((entry) => typeof entry !== "string")) {
        throw new MobiusProtocolError(`The Platform returned an invalid ${field}`);
    }
    return Object.freeze(candidate.filter((entry) => typeof entry === "string"));
}

function requestedIdentifier(value: string, name: string): string {
    if (!IDENTIFIER_PATTERN.test(value)) {
        throw new MobiusValidationError(`The Platform ${name} is invalid`);
    }
    return value;
}

function requestedDisplayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120) {
        throw new MobiusValidationError("The Platform display name is invalid");
    }
    return normalized;
}

function requestedLifetime(value: number, maximumSeconds: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 60 || value > maximumSeconds) {
        throw new MobiusValidationError(`The ${name} lifetime is invalid`);
    }
    return value;
}

function requestedPermissions(value: readonly string[]): readonly string[] {
    if (
        value.length === 0 ||
        value.length > 64 ||
        value.some((permission) => permission.length === 0 || permission.length > 128) ||
        new Set(value).size !== value.length
    ) {
        throw new MobiusValidationError("The Platform permission set is invalid");
    }
    return Object.freeze([...value]);
}

export class MobiusOidcCredentialProvider extends StaticMobiusCredentialProvider {}

export class MobiusAppCredentialProvider extends StaticMobiusCredentialProvider {
    constructor(credential: string) {
        if (!APP_CREDENTIAL_PATTERN.test(credential)) {
            throw new MobiusValidationError("The AppCredential is invalid");
        }
        super(credential);
    }
}

export class MobiusConversationCredentialProvider extends StaticMobiusCredentialProvider {
    constructor(credential: string) {
        if (!CONVERSATION_CREDENTIAL_PATTERN.test(credential)) {
            throw new MobiusValidationError("The ConversationAccessCredential is invalid");
        }
        super(credential);
    }
}

export class MobiusPlatformTenant {
    readonly createdAt: string;
    readonly deletedAt: string;
    readonly displayName: string;
    readonly lifecycle: string;
    readonly quotas: Readonly<Record<string, unknown>>;
    readonly suspendedAt: string;
    readonly tenantId: string;
    readonly updatedAt: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.createdAt = timestamp(value, "createdAt");
        this.deletedAt = timestamp(value, "deletedAt");
        this.displayName = string(value, "displayName", 120);
        this.lifecycle = string(value, "lifecycle", 32);
        this.quotas = record(value["quotas"], "Tenant quotas");
        this.suspendedAt = timestamp(value, "suspendedAt");
        this.tenantId = identifier(value, "tenantId");
        this.updatedAt = timestamp(value, "updatedAt");
    }
}

export class MobiusPlatformConfiguration {
    readonly allowedOrigins: readonly string[];
    readonly anonymousPublicBootstrap: boolean;
    readonly hostingProfile: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.allowedOrigins = strings(value, "allowedOrigins");
        if (typeof value["anonymousPublicBootstrap"] !== "boolean") {
            throw new MobiusProtocolError("The Platform returned an invalid bootstrap configuration");
        }
        this.anonymousPublicBootstrap = value["anonymousPublicBootstrap"];
        this.hostingProfile = string(value, "hostingProfile", 32);
    }
}

export class MobiusPlatformTenantUsage {
    readonly activeApps: number;
    readonly activeProjects: number;
    readonly activeSessions: number;
    readonly quotas: Readonly<Record<string, unknown>>;
    readonly tenantId: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.activeApps = integer(value, "activeApps");
        this.activeProjects = integer(value, "activeProjects");
        this.activeSessions = integer(value, "activeSessions");
        this.quotas = record(value["quotas"], "Tenant quotas");
        this.tenantId = identifier(value, "tenantId");
    }
}

export class MobiusPlatformAuditEvent {
    readonly action: string;
    readonly actorId: string;
    readonly actorKind: string;
    readonly actorRef: string;
    readonly appId: string;
    readonly auditId: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly outcome: string;
    readonly projectId: string;
    readonly recordedAt: string;
    readonly subjectId: string;
    readonly tenantId: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.action = string(value, "action", 128);
        this.actorId = string(value, "actorId", 256);
        this.actorKind = string(value, "actorKind", 64);
        this.actorRef = string(value, "actorRef", 200);
        this.appId = string(value, "appId", 128);
        this.auditId = identifier(value, "auditId");
        this.details = record(value["details"], "audit details");
        this.outcome = string(value, "outcome", 32);
        this.projectId = string(value, "projectId", 128);
        this.recordedAt = timestamp(value, "recordedAt");
        this.subjectId = string(value, "subjectId", 128);
        this.tenantId = identifier(value, "tenantId");
    }
}

export class MobiusPlatformAppCredential {
    readonly appId: string;
    readonly credential: string;
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly issuedAt: string;
    readonly permissions: readonly string[];
    readonly publicCredentialId: string;
    readonly revision: number;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.appId = identifier(value, "appId");
        this.credential = string(value, "credential");
        if (!APP_CREDENTIAL_PATTERN.test(this.credential)) {
            throw new MobiusProtocolError("The Platform returned an invalid AppCredential");
        }
        this.credentialId = identifier(value, "credentialId");
        this.expiresAt = timestamp(value, "expiresAt");
        this.issuedAt = timestamp(value, "issuedAt");
        this.permissions = strings(value, "permissions");
        this.publicCredentialId = string(value, "publicCredentialId", 64);
        this.revision = integer(value, "revision");
    }
}

export class MobiusRotatedPlatformAppCredential extends MobiusPlatformAppCredential {
    readonly overlapEndsAt: string;
    readonly replacedCredentialId: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        super(value);
        this.overlapEndsAt = timestamp(value, "overlapEndsAt");
        this.replacedCredentialId = identifier(value, "replacedCredentialId");
    }
}

export class MobiusPlatformApp {
    readonly appId: string;
    readonly createdAt: string;
    readonly defaultCredentialId: string;
    readonly deletedAt: string;
    readonly displayName: string;
    readonly lifecycle: string;
    readonly suspendedAt: string;
    readonly tenantId: string;
    readonly updatedAt: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.appId = identifier(value, "appId");
        this.createdAt = timestamp(value, "createdAt");
        this.defaultCredentialId = identifier(value, "defaultCredentialId");
        this.deletedAt = timestamp(value, "deletedAt");
        this.displayName = string(value, "displayName", 120);
        this.lifecycle = string(value, "lifecycle", 32);
        this.suspendedAt = timestamp(value, "suspendedAt");
        this.tenantId = identifier(value, "tenantId");
        this.updatedAt = timestamp(value, "updatedAt");
    }
}

export class MobiusCreatedPlatformApp extends MobiusPlatformApp {
    readonly defaultCredential: MobiusPlatformAppCredential;

    constructor(value: Readonly<Record<string, unknown>>) {
        super(value);
        this.defaultCredential = new MobiusPlatformAppCredential(
            record(value["defaultCredential"], "default AppCredential"),
        );
    }
}

export class MobiusPlatformProject {
    readonly appId: string;
    readonly clientReference: string;
    readonly createdAt: string;
    readonly deletedAt: string;
    readonly displayName: string;
    readonly lifecycle: string;
    readonly projectId: string;
    readonly suspendedAt: string;
    readonly tenantId: string;
    readonly updatedAt: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.appId = identifier(value, "appId");
        this.clientReference = identifier(value, "clientReference");
        this.createdAt = timestamp(value, "createdAt");
        this.deletedAt = timestamp(value, "deletedAt");
        this.displayName = string(value, "displayName", 120);
        this.lifecycle = string(value, "lifecycle", 32);
        this.projectId = identifier(value, "projectId");
        this.suspendedAt = timestamp(value, "suspendedAt");
        this.tenantId = identifier(value, "tenantId");
        this.updatedAt = timestamp(value, "updatedAt");
    }
}

export class MobiusConversationAccessCredential {
    readonly actorRef: string;
    readonly appId: string;
    readonly conversationId: string;
    readonly credential: string;
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly issuedAt: string;
    readonly permissions: readonly string[];
    readonly projectId: string;
    readonly sessionId: string;
    readonly tenantId: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.actorRef = string(value, "actorRef", 200);
        this.appId = identifier(value, "appId");
        this.conversationId = identifier(value, "conversationId");
        this.credential = string(value, "credential");
        if (!CONVERSATION_CREDENTIAL_PATTERN.test(this.credential)) {
            throw new MobiusProtocolError("The Platform returned an invalid ConversationAccessCredential");
        }
        this.credentialId = identifier(value, "credentialId");
        this.expiresAt = timestamp(value, "expiresAt");
        this.issuedAt = timestamp(value, "issuedAt");
        this.permissions = strings(value, "permissions");
        this.projectId = identifier(value, "projectId");
        this.sessionId = identifier(value, "sessionId");
        this.tenantId = identifier(value, "tenantId");
    }
}

export class MobiusRotatedConversationAccessCredential extends MobiusConversationAccessCredential {
    readonly replacedCredentialId: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        super(value);
        this.replacedCredentialId = identifier(value, "replacedCredentialId");
    }
}

export class MobiusCredentialRevocation {
    readonly credentialId: string;
    readonly revokedAt: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.credentialId = identifier(value, "credentialId");
        this.revokedAt = timestamp(value, "revokedAt");
    }
}

export interface MobiusCreatePlatformProjectRequest {
    readonly clientReference: string;
    readonly displayName: string;
    readonly idempotencyKey: string;
}

export interface MobiusIssueAppCredentialRequest {
    readonly expiresInSeconds: number;
    readonly permissions: readonly string[];
    readonly projectIds: readonly string[];
}

export interface MobiusIssueConversationAccessCredentialRequest {
    readonly actorRef: string;
    readonly expiresInSeconds: number;
    readonly permissions: readonly string[];
}

export interface MobiusPlatformDeveloperClientOptions extends MobiusEndpointOptions {
    readonly authenticationProviderId: string;
}

export class MobiusPlatformDeveloperClient {
    readonly #executor: MobiusRequestExecutor;

    constructor(options: MobiusPlatformDeveloperClientOptions) {
        if (!IDENTIFIER_PATTERN.test(options.authenticationProviderId)) {
            throw new MobiusValidationError("The OIDC provider identifier is invalid");
        }
        this.#executor = new MobiusRequestExecutor(options);
    }

    readonly createTenant = async (displayName: string, signal: AbortSignal): Promise<MobiusPlatformTenant> =>
        new MobiusPlatformTenant(
            record(
                await this.#executor.post(
                    "v1/platform/tenants",
                    { displayName: requestedDisplayName(displayName) },
                    signal,
                ),
                "Tenant",
            ),
        );

    readonly readConfiguration = async (signal: AbortSignal): Promise<MobiusPlatformConfiguration> =>
        new MobiusPlatformConfiguration(
            record(await this.#executor.get("v1/platform/configuration", signal), "Platform configuration"),
        );

    readonly readApp = async (appId: string, signal: AbortSignal): Promise<MobiusPlatformApp> =>
        new MobiusPlatformApp(
            record(
                await this.#executor.get(
                    `v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}`,
                    signal,
                ),
                "App",
            ),
        );

    readonly readTenantUsage = async (tenantId: string, signal: AbortSignal): Promise<MobiusPlatformTenantUsage> =>
        new MobiusPlatformTenantUsage(
            record(
                await this.#executor.get(
                    `v1/platform/tenants/${encodeURIComponent(requestedIdentifier(tenantId, "Tenant identifier"))}/usage`,
                    signal,
                ),
                "Tenant usage",
            ),
        );

    readonly listAuditEvents = async (
        tenantId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly MobiusPlatformAuditEvent[]> => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new MobiusValidationError("The Platform audit page size is invalid");
        }
        const value = record(
            await this.#executor.get(
                `v1/platform/tenants/${encodeURIComponent(requestedIdentifier(tenantId, "Tenant identifier"))}/audit-events?limit=${limit.toString()}`,
                signal,
            ),
            "audit page",
        );
        const events = value["events"];
        if (!Array.isArray(events) || events.length > 500) {
            throw new MobiusProtocolError("The Platform returned an invalid audit page");
        }
        return Object.freeze(events.map((event) => new MobiusPlatformAuditEvent(record(event, "audit event"))));
    };

    readonly listApps = async (tenantId: string, signal: AbortSignal): Promise<readonly MobiusPlatformApp[]> => {
        const value = record(
            await this.#executor.get(
                `v1/platform/tenants/${encodeURIComponent(requestedIdentifier(tenantId, "Tenant identifier"))}/apps`,
                signal,
            ),
            "App list",
        );
        const apps = value["apps"];
        if (!Array.isArray(apps) || apps.length > 1_000) {
            throw new MobiusProtocolError("The Platform returned an invalid App list");
        }
        return Object.freeze(apps.map((app) => new MobiusPlatformApp(record(app, "App"))));
    };

    readonly createApp = async (
        tenantId: string,
        displayName: string,
        signal: AbortSignal,
    ): Promise<MobiusCreatedPlatformApp> =>
        new MobiusCreatedPlatformApp(
            record(
                await this.#executor.post(
                    "v1/apps",
                    {
                        displayName: requestedDisplayName(displayName),
                        tenantId: requestedIdentifier(tenantId, "Tenant identifier"),
                    },
                    signal,
                ),
                "App",
            ),
        );

    readonly listProjects = async (appId: string, signal: AbortSignal): Promise<readonly MobiusPlatformProject[]> => {
        const value = record(
            await this.#executor.get(
                `v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/projects`,
                signal,
            ),
            "Project list",
        );
        const projects = value["projects"];
        if (!Array.isArray(projects) || projects.length > 10_000) {
            throw new MobiusProtocolError("The Platform returned an invalid Project list");
        }
        return Object.freeze(projects.map((project) => new MobiusPlatformProject(record(project, "Project"))));
    };

    readonly createProject = async (
        appId: string,
        request: MobiusCreatePlatformProjectRequest,
        signal: AbortSignal,
    ): Promise<MobiusPlatformProject> =>
        new MobiusPlatformProject(
            record(
                await this.#executor.post(
                    `v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/projects`,
                    {
                        clientReference: requestedIdentifier(request.clientReference, "Project client reference"),
                        displayName: requestedDisplayName(request.displayName),
                        idempotencyKey: requestedIdentifier(request.idempotencyKey, "Project idempotency key"),
                    },
                    signal,
                ),
                "Project",
            ),
        );

    readonly issueAppCredential = async (
        appId: string,
        request: MobiusIssueAppCredentialRequest,
        signal: AbortSignal,
    ): Promise<MobiusPlatformAppCredential> =>
        new MobiusPlatformAppCredential(
            record(
                await this.#executor.post(
                    `v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/credentials`,
                    {
                        expiresInSeconds: requestedLifetime(
                            request.expiresInSeconds,
                            365 * 24 * 60 * 60,
                            "AppCredential",
                        ),
                        permissions: requestedPermissions(request.permissions),
                        projectIds: Object.freeze(
                            request.projectIds.map((projectId) => requestedIdentifier(projectId, "Project identifier")),
                        ),
                    },
                    signal,
                ),
                "AppCredential",
            ),
        );

    readonly rotateAppCredential = async (
        credentialId: string,
        expiresInSeconds: number,
        overlapSeconds: number,
        signal: AbortSignal,
    ): Promise<MobiusRotatedPlatformAppCredential> => {
        if (!Number.isSafeInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 3_600) {
            throw new MobiusValidationError("The AppCredential overlap is invalid");
        }
        return new MobiusRotatedPlatformAppCredential(
            record(
                await this.#executor.post(
                    `v1/platform/app-credentials/${encodeURIComponent(requestedIdentifier(credentialId, "AppCredential identifier"))}/rotate`,
                    {
                        expiresInSeconds: requestedLifetime(expiresInSeconds, 365 * 24 * 60 * 60, "AppCredential"),
                        overlapSeconds,
                    },
                    signal,
                ),
                "rotated AppCredential",
            ),
        );
    };

    readonly revokeAppCredential = async (
        credentialId: string,
        signal: AbortSignal,
    ): Promise<MobiusCredentialRevocation> =>
        new MobiusCredentialRevocation(
            record(
                await this.#executor.post(
                    `v1/platform/app-credentials/${encodeURIComponent(requestedIdentifier(credentialId, "AppCredential identifier"))}/revoke`,
                    {},
                    signal,
                ),
                "AppCredential revocation",
            ),
        );
}

export class MobiusPlatformAppClient {
    readonly #executor: MobiusRequestExecutor;

    constructor(options: MobiusEndpointOptions) {
        if (options.authenticationProviderId !== undefined) {
            throw new MobiusValidationError("AppCredential requests cannot select a developer authentication provider");
        }
        this.#executor = new MobiusRequestExecutor(options);
    }

    readonly issueConversationAccessCredential = async (
        conversationId: string,
        request: MobiusIssueConversationAccessCredentialRequest,
        signal: AbortSignal,
    ): Promise<MobiusConversationAccessCredential> =>
        new MobiusConversationAccessCredential(
            record(
                await this.#executor.post(
                    `v1/conversations/${encodeURIComponent(requestedIdentifier(conversationId, "Conversation identifier"))}/access-credentials`,
                    {
                        actorRef: request.actorRef,
                        expiresInSeconds: requestedLifetime(
                            request.expiresInSeconds,
                            3_600,
                            "ConversationAccessCredential",
                        ),
                        permissions: requestedPermissions(request.permissions),
                    },
                    signal,
                ),
                "ConversationAccessCredential",
            ),
        );

    readonly rotateConversationAccessCredential = async (
        credentialId: string,
        expiresInSeconds: number,
        signal: AbortSignal,
    ): Promise<MobiusRotatedConversationAccessCredential> =>
        new MobiusRotatedConversationAccessCredential(
            record(
                await this.#executor.post(
                    `v1/conversation-access-credentials/${encodeURIComponent(requestedIdentifier(credentialId, "ConversationAccessCredential identifier"))}/rotate`,
                    { expiresInSeconds: requestedLifetime(expiresInSeconds, 3_600, "ConversationAccessCredential") },
                    signal,
                ),
                "rotated ConversationAccessCredential",
            ),
        );

    readonly revokeConversationAccessCredential = async (
        credentialId: string,
        signal: AbortSignal,
    ): Promise<MobiusCredentialRevocation> =>
        new MobiusCredentialRevocation(
            record(
                await this.#executor.post(
                    `v1/conversation-access-credentials/${encodeURIComponent(requestedIdentifier(credentialId, "ConversationAccessCredential identifier"))}/revoke`,
                    {},
                    signal,
                ),
                "ConversationAccessCredential revocation",
            ),
        );
}
