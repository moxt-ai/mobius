import {
    createdOrganizationInviteSchema,
    decodeIdentifier,
    type Identifier,
    isIdentifier,
    organizationInviteListSchema,
    organizationInvitePreviewSchema,
    organizationInviteRequestSchema,
    type ProjectLocationHint,
} from "@moxt-ai/mobius-protocol";
import { MobiusProtocolError, MobiusValidationError } from "./errors.ts";
import { type MobiusEndpointOptions, MobiusRequestExecutor, StaticMobiusCredentialProvider } from "./service-client.ts";

export type { OrganizationInvite, OrganizationInvitePreview } from "@moxt-ai/mobius-protocol";
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
export type { MobiusCredentialProvider } from "./service-client.ts";
export type { MobiusHttpTransport } from "./transport/http-transport.ts";
export { HttpTransport } from "./transport/http-transport.ts";
export type { MobiusWebSocketConnector, WsTransportOptions } from "./transport/ws-transport.ts";
export { WsTransport } from "./transport/ws-transport.ts";

const APP_CREDENTIAL_PATTERN = /^mapp_[a-zA-Z0-9_-]{22}_[a-zA-Z0-9_-]{43}$/;

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

function identifier(value: Readonly<Record<string, unknown>>, field: string): Identifier {
    try {
        return decodeIdentifier(value[field]);
    } catch {
        throw new MobiusProtocolError(`The Platform returned an invalid ${field}`);
    }
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

function boolean(value: Readonly<Record<string, unknown>>, field: string): boolean {
    const candidate = value[field];
    if (typeof candidate !== "boolean") {
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

function requestedIdentifier(value: string, name: string): Identifier {
    if (!isIdentifier(value)) {
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

const MOBIUS_EFFECTIVE_RECORDING_POLICY_MODES = Object.freeze(["enabled", "disabled"] as const);

function recordingPolicyMode(value: Readonly<Record<string, unknown>>, field: string): MobiusRecordingPolicyMode {
    const candidate = value[field];
    if (typeof candidate !== "string" || !(MOBIUS_RECORDING_POLICY_MODES as readonly string[]).includes(candidate)) {
        throw new MobiusProtocolError(`The Platform returned an invalid ${field}`);
    }
    return candidate as MobiusRecordingPolicyMode;
}

function effectiveRecordingPolicyMode(
    value: Readonly<Record<string, unknown>>,
    field: string,
): MobiusEffectiveRecordingPolicyMode {
    const candidate = value[field];
    if (
        typeof candidate !== "string" ||
        !(MOBIUS_EFFECTIVE_RECORDING_POLICY_MODES as readonly string[]).includes(candidate)
    ) {
        throw new MobiusProtocolError(`The Platform returned an invalid ${field}`);
    }
    return candidate as MobiusEffectiveRecordingPolicyMode;
}

function recordingPolicySource(value: Readonly<Record<string, unknown>>, field: string): MobiusRecordingPolicySource {
    const candidate = value[field];
    if (candidate !== "system" && candidate !== "app" && candidate !== "project") {
        throw new MobiusProtocolError(`The Platform returned an invalid ${field}`);
    }
    return candidate;
}

function requestedRecordingPolicyMode(value: MobiusRecordingPolicyMode): MobiusRecordingPolicyMode {
    if (!(MOBIUS_RECORDING_POLICY_MODES as readonly string[]).includes(value)) {
        throw new MobiusValidationError("The Platform Recording policy mode is invalid");
    }
    return value;
}

function requestedWebhookEndpoint(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new MobiusValidationError("The webhook endpoint is invalid");
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
        throw new MobiusValidationError("The webhook endpoint must use HTTPS");
    }
    return url.toString();
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
        this.anonymousPublicBootstrap = boolean(value, "anonymousPublicBootstrap");
        this.hostingProfile = string(value, "hostingProfile", 32);
    }
}

export class MobiusPlatformTenantUsage {
    readonly activeApps: number;
    readonly activeProjects: number;
    readonly quotas: Readonly<Record<string, unknown>>;
    readonly tenantId: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.activeApps = integer(value, "activeApps");
        this.activeProjects = integer(value, "activeProjects");
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
        this.issuedAt = timestamp(value, "issuedAt");
        this.permissions = strings(value, "permissions");
        this.publicCredentialId = string(value, "publicCredentialId", 64);
        this.revision = integer(value, "revision");
    }
}

export class MobiusPlatformAppCredentialMetadata {
    readonly allProjects: boolean;
    readonly appId: string;
    readonly credentialId: string;
    readonly issuedAt: string;
    readonly lastUsedAt: string;
    readonly overlapEndsAt: string;
    readonly permissions: readonly string[];
    readonly projectIds: readonly string[];
    readonly publicCredentialId: string;
    readonly replacedByCredentialId: string;
    readonly revision: number;
    readonly revokedAt: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        if (typeof value["allProjects"] !== "boolean") {
            throw new MobiusProtocolError("The Platform returned an invalid AppCredential scope");
        }
        this.allProjects = value["allProjects"];
        this.appId = identifier(value, "appId");
        this.credentialId = identifier(value, "credentialId");
        this.issuedAt = timestamp(value, "issuedAt");
        this.lastUsedAt = timestamp(value, "lastUsedAt");
        this.overlapEndsAt = timestamp(value, "overlapEndsAt");
        this.permissions = strings(value, "permissions");
        this.projectIds = strings(value, "projectIds");
        this.publicCredentialId = string(value, "publicCredentialId", 64);
        this.replacedByCredentialId = string(value, "replacedByCredentialId", 128);
        this.revision = integer(value, "revision");
        this.revokedAt = timestamp(value, "revokedAt");
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

export class MobiusCredentialRevocation {
    readonly credentialId: string;
    readonly revokedAt: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.credentialId = identifier(value, "credentialId");
        this.revokedAt = timestamp(value, "revokedAt");
    }
}

export const MOBIUS_RECORDING_POLICY_MODES = Object.freeze(["inherit", "enabled", "disabled"] as const);

export type MobiusRecordingPolicyMode = (typeof MOBIUS_RECORDING_POLICY_MODES)[number];
export type MobiusEffectiveRecordingPolicyMode = Exclude<MobiusRecordingPolicyMode, "inherit">;
export type MobiusRecordingPolicySource = "system" | "app" | "project";

export class MobiusPlatformRecordingPolicy {
    readonly effectiveMode: MobiusEffectiveRecordingPolicyMode;
    readonly inheritedFrom: MobiusRecordingPolicySource;
    readonly mode: MobiusRecordingPolicyMode;
    readonly providerAvailable: boolean;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.effectiveMode = effectiveRecordingPolicyMode(value, "effectiveMode");
        this.inheritedFrom = recordingPolicySource(value, "inheritedFrom");
        this.mode = recordingPolicyMode(value, "mode");
        this.providerAvailable = boolean(value, "providerAvailable");
    }
}

export class MobiusPlatformAppSessionStatusWebhook {
    readonly appId: string;
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly secret: string | undefined;
    readonly secretId: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        this.appId = identifier(value, "appId");
        this.configured = boolean(value, "configured");
        this.enabled = boolean(value, "enabled");
        this.endpoint = string(value, "endpoint", 2048);
        this.secretId = string(value, "secretId", 128);
        const secret = value["secret"];
        this.secret = typeof secret === "string" ? string({ secret }, "secret", 256) : undefined;
    }
}

export interface MobiusCreatePlatformProjectRequest {
    readonly clientReference: string;
    readonly displayName: string;
    readonly idempotencyKey: string;
    readonly locationHint: ProjectLocationHint;
}

export interface MobiusIssueAppCredentialRequest {
    readonly permissions: readonly string[];
    readonly projectIds: readonly string[];
}

export interface MobiusPlatformDeveloperClientOptions extends MobiusEndpointOptions {
    readonly authenticationProviderId: string;
}

export class MobiusPlatformDeveloperClient {
    readonly #options: MobiusPlatformDeveloperClientOptions;
    readonly #executor: MobiusRequestExecutor;
    readonly webhooks: MobiusPlatformAppSessionStatusWebhookClient;

    constructor(options: MobiusPlatformDeveloperClientOptions) {
        if (!isIdentifier(options.authenticationProviderId)) {
            throw new MobiusValidationError("The OIDC provider identifier is invalid");
        }
        this.#options = options;
        this.#executor = new MobiusRequestExecutor(options);
        this.webhooks = new MobiusPlatformAppSessionStatusWebhookClient(this.#options);
    }

    readonly createOrganizationInvite = async (organizationId: string, signal: AbortSignal) => {
        const value = await this.#executor.post(
            `dashboard/v1/platform/tenants/${requestedIdentifier(organizationId, "organization")}/invite-links`,
            {},
            signal,
        );
        const result = createdOrganizationInviteSchema.safeParse(value);
        if (!result.success) {
            throw new MobiusProtocolError("The Platform returned an invalid invitation");
        }
        return result.data;
    };

    readonly listOrganizationInvites = async (organizationId: string, signal: AbortSignal) => {
        const value = await this.#executor.get(
            `dashboard/v1/platform/tenants/${requestedIdentifier(organizationId, "organization")}/invite-links`,
            signal,
        );
        const result = organizationInviteListSchema.safeParse(value);
        if (!result.success) {
            throw new MobiusProtocolError("The Platform returned an invalid invitation list");
        }
        return result.data;
    };

    readonly revokeOrganizationInvite = async (
        organizationId: string,
        id: string,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#executor.delete(
            `dashboard/v1/platform/tenants/${requestedIdentifier(organizationId, "organization")}/invite-links/${requestedIdentifier(id, "invitation")}`,
            signal,
        );
    };

    readonly previewOrganizationInvite = async (token: string, signal: AbortSignal) =>
        this.organizationInvite("preview", token, signal);
    readonly acceptOrganizationInvite = async (token: string, signal: AbortSignal) =>
        this.organizationInvite("accept", token, signal);

    private readonly organizationInvite = async (action: "preview" | "accept", token: string, signal: AbortSignal) => {
        const body = organizationInviteRequestSchema.safeParse({ token });
        if (!body.success) {
            throw new MobiusValidationError("The invitation link is invalid");
        }
        const result = organizationInvitePreviewSchema.safeParse(
            await this.#executor.post(`dashboard/v1/platform/invite-links/${action}`, body.data, signal),
        );
        if (!result.success) {
            throw new MobiusProtocolError("The Platform returned an invalid invitation");
        }
        return result.data;
    };

    readonly listTenants = async (signal: AbortSignal): Promise<readonly MobiusPlatformTenant[]> => {
        const value = record(await this.#executor.get("dashboard/v1/platform/tenants", signal), "Tenant list");
        const tenants = value["tenants"];
        if (!Array.isArray(tenants) || tenants.length > 1_000) {
            throw new MobiusProtocolError("The Platform returned an invalid Tenant list");
        }
        return Object.freeze(tenants.map((tenant) => new MobiusPlatformTenant(record(tenant, "Tenant"))));
    };

    readonly readTenant = async (tenantId: string, signal: AbortSignal): Promise<MobiusPlatformTenant> =>
        new MobiusPlatformTenant(
            record(
                await this.#executor.get(
                    `dashboard/v1/platform/tenants/${encodeURIComponent(requestedIdentifier(tenantId, "Tenant identifier"))}`,
                    signal,
                ),
                "Tenant",
            ),
        );

    readonly readConfiguration = async (signal: AbortSignal): Promise<MobiusPlatformConfiguration> =>
        new MobiusPlatformConfiguration(
            record(await this.#executor.get("dashboard/v1/platform/configuration", signal), "Platform configuration"),
        );

    readonly readApp = async (appId: string, signal: AbortSignal): Promise<MobiusPlatformApp> =>
        new MobiusPlatformApp(
            record(
                await this.#executor.get(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}`,
                    signal,
                ),
                "App",
            ),
        );

    readonly readTenantUsage = async (tenantId: string, signal: AbortSignal): Promise<MobiusPlatformTenantUsage> =>
        new MobiusPlatformTenantUsage(
            record(
                await this.#executor.get(
                    `dashboard/v1/platform/tenants/${encodeURIComponent(requestedIdentifier(tenantId, "Tenant identifier"))}/usage`,
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
                `dashboard/v1/platform/tenants/${encodeURIComponent(requestedIdentifier(tenantId, "Tenant identifier"))}/audit-events?limit=${limit.toString()}`,
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
                `dashboard/v1/platform/tenants/${encodeURIComponent(requestedIdentifier(tenantId, "Tenant identifier"))}/apps`,
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
                    "dashboard/v1/apps",
                    {
                        displayName: requestedDisplayName(displayName),
                        tenantId: requestedIdentifier(tenantId, "Tenant identifier"),
                    },
                    signal,
                ),
                "App",
            ),
        );

    readonly updateApp = async (appId: string, displayName: string, signal: AbortSignal): Promise<MobiusPlatformApp> =>
        new MobiusPlatformApp(
            record(
                await this.#executor.put(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}`,
                    {
                        displayName: requestedDisplayName(displayName),
                    },
                    signal,
                ),
                "App",
            ),
        );

    readonly deleteApp = async (appId: string, signal: AbortSignal): Promise<MobiusPlatformApp> =>
        new MobiusPlatformApp(
            record(
                await this.#executor.delete(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}`,
                    signal,
                ),
                "App",
            ),
        );

    readonly listProjects = async (appId: string, signal: AbortSignal): Promise<readonly MobiusPlatformProject[]> => {
        const value = record(
            await this.#executor.get(
                `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/projects`,
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
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/projects`,
                    {
                        clientReference: requestedIdentifier(request.clientReference, "Project client reference"),
                        displayName: requestedDisplayName(request.displayName),
                        idempotencyKey: requestedIdentifier(request.idempotencyKey, "Project idempotency key"),
                        locationHint: requestedIdentifier(request.locationHint, "Location hint"),
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
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/credentials`,
                    {
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

    readonly listAppCredentials = async (
        appId: string,
        signal: AbortSignal,
    ): Promise<readonly MobiusPlatformAppCredentialMetadata[]> => {
        const value = record(
            await this.#executor.get(
                `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/credentials`,
                signal,
            ),
            "AppCredential list",
        );
        const credentials = value["credentials"];
        if (!Array.isArray(credentials) || credentials.length > 10_000) {
            throw new MobiusProtocolError("The Platform returned an invalid AppCredential list");
        }
        return Object.freeze(
            credentials.map(
                (credential) => new MobiusPlatformAppCredentialMetadata(record(credential, "AppCredential")),
            ),
        );
    };

    readonly rotateAppCredential = async (
        credentialId: string,
        overlapSeconds: number,
        signal: AbortSignal,
    ): Promise<MobiusRotatedPlatformAppCredential> => {
        if (!Number.isSafeInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 3_600) {
            throw new MobiusValidationError("The AppCredential overlap is invalid");
        }
        return new MobiusRotatedPlatformAppCredential(
            record(
                await this.#executor.post(
                    `dashboard/v1/platform/app-credentials/${encodeURIComponent(requestedIdentifier(credentialId, "AppCredential identifier"))}/rotate`,
                    {
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
                    `dashboard/v1/platform/app-credentials/${encodeURIComponent(requestedIdentifier(credentialId, "AppCredential identifier"))}/revoke`,
                    {},
                    signal,
                ),
                "AppCredential revocation",
            ),
        );

    readonly readAppRecordingPolicy = async (
        appId: string,
        signal: AbortSignal,
    ): Promise<MobiusPlatformRecordingPolicy> =>
        new MobiusPlatformRecordingPolicy(
            record(
                await this.#executor.get(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/recording-policy`,
                    signal,
                ),
                "Recording policy",
            ),
        );

    readonly writeAppRecordingPolicy = async (
        appId: string,
        mode: MobiusRecordingPolicyMode,
        signal: AbortSignal,
    ): Promise<MobiusPlatformRecordingPolicy> =>
        new MobiusPlatformRecordingPolicy(
            record(
                await this.#executor.put(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/recording-policy`,
                    { mode: requestedRecordingPolicyMode(mode) },
                    signal,
                ),
                "Recording policy",
            ),
        );

    readonly readProjectRecordingPolicy = async (
        projectId: string,
        signal: AbortSignal,
    ): Promise<MobiusPlatformRecordingPolicy> =>
        new MobiusPlatformRecordingPolicy(
            record(
                await this.#executor.get(
                    `dashboard/v1/projects/${encodeURIComponent(requestedIdentifier(projectId, "Project identifier"))}/recording-policy`,
                    signal,
                ),
                "Recording policy",
            ),
        );

    readonly writeProjectRecordingPolicy = async (
        projectId: string,
        mode: MobiusRecordingPolicyMode,
        signal: AbortSignal,
    ): Promise<MobiusPlatformRecordingPolicy> =>
        new MobiusPlatformRecordingPolicy(
            record(
                await this.#executor.put(
                    `dashboard/v1/projects/${encodeURIComponent(requestedIdentifier(projectId, "Project identifier"))}/recording-policy`,
                    { mode: requestedRecordingPolicyMode(mode) },
                    signal,
                ),
                "Recording policy",
            ),
        );
}

export class MobiusPlatformAppSessionStatusWebhookClient {
    readonly #executor: MobiusRequestExecutor;

    constructor(options: MobiusEndpointOptions) {
        this.#executor = new MobiusRequestExecutor(options);
    }

    readonly read = async (appId: string, signal: AbortSignal): Promise<MobiusPlatformAppSessionStatusWebhook> =>
        new MobiusPlatformAppSessionStatusWebhook(
            record(
                await this.#executor.get(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/session-status-webhook`,
                    signal,
                ),
                "App Session status webhook",
            ),
        );

    readonly write = async (
        appId: string,
        request: { readonly enabled: boolean; readonly endpoint: string },
        signal: AbortSignal,
    ): Promise<MobiusPlatformAppSessionStatusWebhook> =>
        new MobiusPlatformAppSessionStatusWebhook(
            record(
                await this.#executor.put(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/session-status-webhook`,
                    {
                        enabled: request.enabled,
                        endpoint: requestedWebhookEndpoint(request.endpoint),
                    },
                    signal,
                ),
                "App Session status webhook",
            ),
        );

    readonly rotate = async (appId: string, signal: AbortSignal): Promise<MobiusPlatformAppSessionStatusWebhook> =>
        new MobiusPlatformAppSessionStatusWebhook(
            record(
                await this.#executor.post(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/session-status-webhook/rotate`,
                    {},
                    signal,
                ),
                "App Session status webhook",
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

    readonly createProject = async (
        appId: string,
        request: MobiusCreatePlatformProjectRequest,
        signal: AbortSignal,
    ): Promise<MobiusPlatformProject> =>
        new MobiusPlatformProject(
            record(
                await this.#executor.post(
                    `dashboard/v1/apps/${encodeURIComponent(requestedIdentifier(appId, "App identifier"))}/projects`,
                    {
                        clientReference: requestedIdentifier(request.clientReference, "Project client reference"),
                        displayName: requestedDisplayName(request.displayName),
                        idempotencyKey: requestedIdentifier(request.idempotencyKey, "Project idempotency key"),
                        locationHint: requestedIdentifier(request.locationHint, "Location hint"),
                    },
                    signal,
                ),
                "Project",
            ),
        );
}
