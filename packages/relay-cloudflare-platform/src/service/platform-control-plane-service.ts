import {
    AuditActor,
    AuditActorKind,
    createRandomToken,
    type decodeProjectCredential,
    decodeProjectPermissions,
    ExternalIdentityCredential,
    hashSecret,
    PerpetualProjectAccessLifetime,
    type ProjectAccessAuthorizer,
    ProjectAccessContext,
    ProjectAuthenticationError,
    type ProjectPermission,
    ProjectScope,
    SessionQuotaPolicy,
    type SessionQuotaPolicyProvider,
    type VerifiedExternalIdentity,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";
import {
    hasControlCharacters,
    PlatformAppCredentialAccess,
    type PlatformAuthenticationConfiguration,
    PlatformControlPlaneError,
    PlatformDeveloperAccess,
    type PlatformPrincipal,
    type PlatformProjectPlacementRegistry,
} from "../entity/platform-control-plane.ts";
import { decodePlatformProjectPlacement, encodePlatformProjectId } from "../entity/platform-project-id.ts";
import type {
    AppRow,
    AuditRow,
    CredentialRow,
    PlatformAppCredentialInsert,
    PlatformAuditRecord,
    ProjectRow,
    TenantRow,
} from "../entity/platform-records.ts";
import type { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";
import type { AppCredentialAuthenticationService } from "./app-credential-authentication-service.ts";

const MAXIMUM_CREDENTIAL_OVERLAP_MILLISECONDS = 60 * 60 * 1_000;

type ProjectProvisioningActor =
    | {
          readonly kind: "platform_developer";
          readonly tenantId: string;
          readonly subject: string;
          readonly credentialId: "";
      }
    | {
          readonly kind: "application";
          readonly tenantId: string;
          readonly subject: string;
          readonly credentialId: string;
      };

const PLATFORM_SERVER_PROJECT_PERMISSIONS: readonly ProjectPermission[] = Object.freeze([
    ...decodeProjectPermissions([
        "artifact:read",
        "artifact:write",
        "bot:behavior:write",
        "bot:binding:write",
        "bot:connection:manage",
        "bot:profile:write",
        "bot:read",
        "conversation:create",
        "conversation:read",
        "conversation:turn:cancel",
        "conversation:turn:create",
        "interaction:respond",
        "project:event:read",
        "project:read",
        "runtime:pair",
        "runtime:read",
        "runtime:revoke",
        "session:delete",
        "session:read",
        "session:write",
    ]),
]);

class TenantQuotas {
    readonly activeApps: number;
    readonly activeProjects: number;
    readonly activeSessions: number;

    constructor(activeApps: number, activeProjects: number, activeSessions: number) {
        if (
            !Number.isSafeInteger(activeApps) ||
            activeApps < 1 ||
            activeApps > 10_000 ||
            !Number.isSafeInteger(activeProjects) ||
            activeProjects < 1 ||
            activeProjects > 100_000 ||
            !Number.isSafeInteger(activeSessions) ||
            activeSessions < 1 ||
            activeSessions > 10_000_000
        ) {
            throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
        }
        this.activeApps = activeApps;
        this.activeProjects = activeProjects;
        this.activeSessions = activeSessions;
    }
}

class CreatedAppCredential {
    readonly appId: string;
    readonly credential: string;
    readonly credentialId: string;
    readonly digest: string;
    readonly issuedAt: number;
    readonly permissions: ReadonlySet<ProjectPermission>;
    readonly publicCredentialId: string;
    readonly revision: number;

    constructor(
        appId: string,
        credential: string,
        credentialId: string,
        publicCredentialId: string,
        digest: string,
        permissions: ReadonlySet<ProjectPermission>,
        revision: number,
        issuedAt: number,
    ) {
        this.appId = appId;
        this.credential = credential;
        this.credentialId = credentialId;
        this.publicCredentialId = publicCredentialId;
        this.digest = digest;
        this.permissions = new Set(permissions);
        this.revision = revision;
        this.issuedAt = issuedAt;
    }

    readonly resource = (): object => ({
        appId: this.appId,
        credential: this.credential,
        credentialId: this.credentialId,
        issuedAt: iso(this.issuedAt),
        permissions: permissionValues(this.permissions),
        publicCredentialId: this.publicCredentialId,
        revision: this.revision,
    });

    readonly storageRecord = (allProjects: boolean): PlatformAppCredentialInsert => ({
        allProjects,
        appId: this.appId,
        credentialId: this.credentialId,
        issuedAt: this.issuedAt,
        permissionsJson: JSON.stringify(permissionValues(this.permissions)),
        publicCredentialId: this.publicCredentialId,
        revision: this.revision,
        secretDigest: this.digest,
    });
}

function displayName(value: string): string {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 120 || hasControlCharacters(normalized)) {
        throw new PlatformControlPlaneError("invalid_request", "The display name is invalid", 400);
    }
    return normalized;
}

function actorReference(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length > 200 || hasControlCharacters(normalized)) {
        throw new PlatformControlPlaneError("invalid_request", "The actor reference is invalid", 400);
    }
    return normalized;
}

function iso(value: number): string {
    return new Date(value).toISOString();
}

function permissionValues(permissions: ReadonlySet<ProjectPermission>): readonly string[] {
    return Object.freeze([...permissions].map((permission) => permission.value).sort());
}

function permissions(encoded: string): ReadonlySet<ProjectPermission> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new ProjectAuthenticationError(
            "project_authorization_record_invalid",
            "The AppCredential authorization record is invalid",
            { cause },
        );
    }
    return decodeProjectPermissions(value);
}

function appPermissions(value: unknown): ReadonlySet<ProjectPermission> {
    const decoded = decodeProjectPermissions(value);
    const allowed = new Set(PLATFORM_SERVER_PROJECT_PERMISSIONS);
    for (const permission of decoded) {
        if (!allowed.has(permission)) {
            throw new PlatformControlPlaneError(
                "app_credential_permission_invalid",
                "The AppCredential permission is not available to Platform applications",
                400,
            );
        }
    }
    return decoded;
}

function overlapMilliseconds(overlapSeconds: number): number {
    if (!Number.isSafeInteger(overlapSeconds)) {
        throw new PlatformControlPlaneError("credential_overlap_invalid", "The AppCredential overlap is invalid", 400);
    }
    const overlap = overlapSeconds * 1_000;
    if (overlap < 0 || overlap > MAXIMUM_CREDENTIAL_OVERLAP_MILLISECONDS) {
        throw new PlatformControlPlaneError("credential_overlap_invalid", "The AppCredential overlap is invalid", 400);
    }
    return overlap;
}

function tenantResource(row: TenantRow): object {
    return {
        createdAt: iso(row.created_at),
        deletedAt: typeof row.deleted_at === "number" ? iso(row.deleted_at) : "",
        displayName: row.display_name,
        lifecycle: row.lifecycle,
        quotas: decodeObject(row.quotas_json, "The Tenant quota record is invalid"),
        suspendedAt: typeof row.suspended_at === "number" ? iso(row.suspended_at) : "",
        tenantId: row.tenant_id,
        updatedAt: iso(row.updated_at),
    };
}

function tenantQuotas(value: unknown): TenantQuotas {
    if (value === undefined) {
        return new TenantQuotas(100, 1_000, 10_000);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
    }
    const quota = Object.freeze(Object.fromEntries(Object.entries(value)));
    if (
        Object.keys(quota).length !== 3 ||
        !Object.hasOwn(quota, "activeApps") ||
        !Object.hasOwn(quota, "activeProjects") ||
        !Object.hasOwn(quota, "activeSessions")
    ) {
        throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
    }
    return new TenantQuotas(
        quotaValue(quota, "activeApps"),
        quotaValue(quota, "activeProjects"),
        quotaValue(quota, "activeSessions"),
    );
}

function quotaValue(value: Readonly<Record<string, unknown>>, key: string): number {
    const candidate = value[key];
    if (typeof candidate !== "number") {
        throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
    }
    return candidate;
}

function quotasFromRow(row: TenantRow): TenantQuotas {
    return tenantQuotas(decodeObject(row.quotas_json, "The Tenant quota record is invalid"));
}

function auditResource(row: AuditRow): object {
    return {
        action: row.action,
        actorId: row.actor_id,
        actorKind: row.actor_kind,
        actorRef: row.actor_ref,
        appId: row.app_id,
        auditId: row.audit_id,
        details: decodeObject(row.details_json, "The Platform audit record is invalid"),
        outcome: row.outcome,
        projectId: row.project_id,
        recordedAt: iso(row.recorded_at),
        subjectId: row.subject_id,
        tenantId: row.tenant_id,
    };
}

function appResource(row: AppRow): object {
    return {
        appId: row.app_id,
        createdAt: iso(row.created_at),
        defaultCredentialId: typeof row.default_credential_id === "string" ? row.default_credential_id : "",
        deletedAt: typeof row.deleted_at === "number" ? iso(row.deleted_at) : "",
        displayName: row.display_name,
        lifecycle: row.lifecycle,
        suspendedAt: typeof row.suspended_at === "number" ? iso(row.suspended_at) : "",
        tenantId: row.tenant_id,
        updatedAt: iso(row.updated_at),
    };
}

function projectResource(row: ProjectRow): object {
    return {
        appId: row.app_id,
        clientReference: row.client_reference,
        createdAt: iso(row.created_at),
        deletedAt: typeof row.deleted_at === "number" ? iso(row.deleted_at) : "",
        displayName: row.display_name,
        lifecycle: row.lifecycle,
        projectId: row.project_id,
        suspendedAt: typeof row.suspended_at === "number" ? iso(row.suspended_at) : "",
        tenantId: row.tenant_id,
        updatedAt: iso(row.updated_at),
    };
}

function decodeObject(encoded: string, message: string): Readonly<Record<string, unknown>> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new PlatformControlPlaneError("platform_record_invalid", message, 500, { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PlatformControlPlaneError("platform_record_invalid", message, 500);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function bearer(request: Request): string {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
        throw new PlatformControlPlaneError(
            "developer_authentication_required",
            "Developer authentication is required",
            401,
        );
    }
    const value = authorization.slice("Bearer ".length);
    if (value.length === 0 || value.length > 16 * 1_024 || hasControlCharacters(value)) {
        throw new PlatformControlPlaneError(
            "developer_authentication_required",
            "Developer authentication is required",
            401,
        );
    }
    return value;
}

async function requestDigest(display: string, clientReference: string, locationHint: string): Promise<string> {
    return await hashSecret(JSON.stringify({ clientReference, displayName: display, locationHint }));
}

export class PlatformControlPlaneService implements ProjectAccessAuthorizer, SessionQuotaPolicyProvider {
    readonly #authentication: PlatformAuthenticationConfiguration;
    readonly #storage: PlatformControlPlaneStorage;
    readonly #placements: PlatformProjectPlacementRegistry;
    readonly #appAuthentication: AppCredentialAuthenticationService;

    constructor(
        storage: PlatformControlPlaneStorage,
        authentication: PlatformAuthenticationConfiguration,
        placements: PlatformProjectPlacementRegistry,
        appAuthentication: AppCredentialAuthenticationService,
    ) {
        this.#storage = storage;
        this.#authentication = authentication;
        this.#placements = placements;
        this.#appAuthentication = appAuthentication;
    }

    readonly authenticateDeveloper = async (
        request: Request,
        signal: AbortSignal,
    ): Promise<VerifiedExternalIdentity> => {
        signal.throwIfAborted();
        const providerId = request.headers.get("x-mobius-oidc-provider") ?? "";
        let credential: ExternalIdentityCredential;
        try {
            credential = new ExternalIdentityCredential(providerId, bearer(request));
            return await this.#authentication.developerAuthenticator.authenticate(credential, signal);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof PlatformControlPlaneError) {
                throw cause;
            }
            throw new PlatformControlPlaneError(
                "developer_authentication_failed",
                "Developer authentication failed",
                401,
                { cause },
            );
        }
    };

    private readonly ensureOrganization = async (
        identity: VerifiedExternalIdentity,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const now = Date.now();
        const tenantId = this.organization(identity).tenantId;
        const existing = await this.#storage.readTenant(tenantId, signal);
        if (existing !== null) {
            return;
        }
        const quotas = JSON.stringify(tenantQuotas(undefined));
        const tenant: TenantRow = {
            created_at: now,
            deleted_at: null,
            display_name: tenantId,
            lifecycle: "active",
            quotas_json: quotas,
            suspended_at: null,
            tenant_id: tenantId,
            updated_at: now,
        };
        const created = await this.#storage.createTenant(
            tenant,
            this.auditRecord(
                tenantId,
                "",
                "",
                "platform_developer",
                identity.subject,
                "",
                "tenant.created",
                tenantId,
                "succeeded",
                {},
                now,
            ),
            signal,
        );
        if (!created) {
            throw new PlatformControlPlaneError("platform_write_failed", "The Tenant could not be created", 503);
        }
    };

    readonly listTenants = async (identity: VerifiedExternalIdentity, signal: AbortSignal): Promise<object> => {
        signal.throwIfAborted();
        const { tenantId } = this.organization(identity);
        await this.ensureOrganization(identity, signal);
        const tenant = await this.readTenant(tenantId, signal);
        return { tenants: [tenantResource(tenant)] };
    };

    readonly readTenantResource = async (
        identity: VerifiedExternalIdentity,
        tenantId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        const access = await this.requireTenantDeveloper(identity, tenantId, signal);
        return tenantResource(await this.readTenant(access.tenantId, signal));
    };

    readonly requireTenantDeveloper = async (
        identity: VerifiedExternalIdentity,
        tenantId: string,
        signal: AbortSignal,
    ): Promise<PlatformDeveloperAccess> => {
        signal.throwIfAborted();
        const normalizedTenantId = validateIdentifier(tenantId, "tenant_id");
        const organization = this.organization(identity);
        if (organization.tenantId !== normalizedTenantId) {
            throw new PlatformControlPlaneError(
                "tenant_access_denied",
                "The developer is not authorized for this Tenant",
                403,
            );
        }
        await this.ensureOrganization(identity, signal);
        await this.readTenant(organization.tenantId, signal);
        return new PlatformDeveloperAccess(identity, organization.tenantId, organization.role);
    };

    private readonly organization = (
        identity: VerifiedExternalIdentity,
    ): { readonly tenantId: string; readonly role: string } => {
        if (identity.providerId !== "clerk" || identity.organization.kind === "none") {
            throw new PlatformControlPlaneError("organization_required", "Select a Clerk organization", 403);
        }
        return {
            tenantId: identity.organization.id,
            role: identity.organization.role === "org:admin" ? "owner" : "developer",
        };
    };

    readonly resolveProjectPlacement = (projectId: string, signal: AbortSignal): { readonly location: string } => {
        signal.throwIfAborted();
        const placement = decodePlatformProjectPlacement(projectId);
        if (placement === null) {
            throw new PlatformControlPlaneError("invalid_request", "The Project identifier is invalid", 400);
        }
        if (!this.#placements.supports(placement)) {
            throw new PlatformControlPlaneError(
                "storage_location_unavailable",
                "The requested storage location is unavailable",
                400,
            );
        }
        return { location: placement.r2BucketId };
    };

    readonly resolveSessionQuota = async (scope: ProjectScope, signal: AbortSignal): Promise<SessionQuotaPolicy> => {
        const project = await this.#storage.readActiveProjectScope(scope.projectId, signal);
        if (project === null) {
            throw new PlatformControlPlaneError("project_not_found", "The Project was not found", 404);
        }
        const tenant = await this.readTenant(project.tenant_id, signal);
        const quota = quotasFromRow(tenant);
        return new SessionQuotaPolicy(quota.activeSessions);
    };

    readonly recordSessionQuotaDenial = async (
        scope: ProjectScope,
        sessionId: string,
        policy: SessionQuotaPolicy,
        signal: AbortSignal,
    ): Promise<void> => {
        const project = await this.#storage.readActiveProjectScope(scope.projectId, signal);
        if (project === null) {
            throw new PlatformControlPlaneError("project_not_found", "The Project was not found", 404);
        }
        const recorded = await this.#storage.recordAudit(
            this.auditRecord(
                project.tenant_id,
                project.app_id,
                scope.projectId,
                "platform_system",
                "session-quota",
                "",
                "quota.denied",
                sessionId,
                "denied",
                { limit: policy.activeSessionsPerProject, resource: "session" },
                Date.now(),
            ),
            signal,
        );
        if (!recorded) {
            throw new PlatformControlPlaneError("platform_write_failed", "The quota denial could not be audited", 503);
        }
    };

    readonly requireAppDeveloper = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        signal: AbortSignal,
    ): Promise<{ readonly access: PlatformDeveloperAccess; readonly app: AppRow }> => {
        signal.throwIfAborted();
        const app = await this.readApp(appId, signal);
        const access = await this.requireTenantDeveloper(identity, app.tenant_id, signal);
        return { access, app };
    };

    readonly createApp = async (
        access: PlatformDeveloperAccess,
        requestedDisplayName: string,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const now = Date.now();
        const tenant = await this.readTenant(access.tenantId, signal);
        const quota = quotasFromRow(tenant);
        const usage = await this.#storage.countActiveApps(access.tenantId, signal);
        if (!Number.isSafeInteger(usage) || usage < 0) {
            throw new PlatformControlPlaneError("platform_record_invalid", "The Tenant App usage is invalid", 500);
        }
        if (usage >= quota.activeApps) {
            await this.recordQuotaDenial(access, "app", access.tenantId, quota.activeApps, signal);
            throw new PlatformControlPlaneError(
                "tenant_app_quota_exceeded",
                "The Tenant active App quota is exhausted",
                429,
            );
        }
        const appId = `app_${createRandomToken(18)}`;
        const normalizedDisplayName = displayName(requestedDisplayName);
        const created = await this.createCredential(appId, new Set(PLATFORM_SERVER_PROJECT_PERMISSIONS), 1, now);
        const appRow: AppRow = {
            app_id: appId,
            created_at: now,
            default_credential_id: created.credentialId,
            deleted_at: null,
            display_name: normalizedDisplayName,
            lifecycle: "active",
            suspended_at: null,
            tenant_id: access.tenantId,
            updated_at: now,
        };
        const stored = await this.#storage.createApp(
            appRow,
            created.storageRecord(true),
            quota.activeApps,
            this.auditRecord(
                access.tenantId,
                appId,
                "",
                "platform_developer",
                access.identity.subject,
                "",
                "app.created",
                appId,
                "succeeded",
                {},
                now,
            ),
            signal,
        );
        if (!stored.appCreated) {
            await this.recordQuotaDenial(access, "app", access.tenantId, quota.activeApps, signal);
            throw new PlatformControlPlaneError(
                "tenant_app_quota_exceeded",
                "The Tenant active App quota is exhausted",
                429,
            );
        }
        if (!stored.relatedRecordsCreated) {
            throw new PlatformControlPlaneError("platform_write_failed", "The App could not be created", 503);
        }
        const app = appResource(appRow);
        return { ...app, defaultCredential: created.resource() };
    };

    readonly updateApp = async (
        access: PlatformDeveloperAccess,
        app: AppRow,
        requestedDisplayName: string,
        signal: AbortSignal,
    ): Promise<object> => {
        this.requireOwner(access);
        if (access.tenantId !== app.tenant_id || app.lifecycle !== "active") {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        const now = Date.now();
        const updated = await this.#storage.updateApp(
            app.app_id,
            displayName(requestedDisplayName),
            now,
            this.auditRecord(
                access.tenantId,
                app.app_id,
                "",
                "platform_developer",
                access.identity.subject,
                "",
                "app.updated",
                app.app_id,
                "succeeded",
                {},
                now,
            ),
            signal,
        );
        if (!updated) {
            throw new PlatformControlPlaneError("platform_write_failed", "The App could not be updated", 503);
        }
        return appResource(await this.readApp(app.app_id, signal));
    };

    readonly deleteApp = async (access: PlatformDeveloperAccess, app: AppRow, signal: AbortSignal): Promise<object> => {
        this.requireOwner(access);
        if (access.tenantId !== app.tenant_id || app.lifecycle !== "active") {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        const now = Date.now();
        const deleted = await this.#storage.deleteApp(
            app.app_id,
            now,
            this.auditRecord(
                access.tenantId,
                app.app_id,
                "",
                "platform_developer",
                access.identity.subject,
                "",
                "app.deleted",
                app.app_id,
                "succeeded",
                {},
                now,
            ),
            signal,
        );
        if (!deleted) {
            throw new PlatformControlPlaneError("app_not_found", "The App was not found", 404);
        }
        for (const credential of await this.#storage.listAppCredentials(app.app_id, signal)) {
            await this.#appAuthentication.invalidate(credential, signal);
        }
        return { ...appResource(app), deletedAt: iso(now), lifecycle: "deleted", updatedAt: iso(now) };
    };

    readonly createProject = async (
        access: PlatformDeveloperAccess,
        app: AppRow,
        requestedDisplayName: string,
        idempotencyKey: string,
        requestedClientReference: string,
        locationHint: string,
        signal: AbortSignal,
    ): Promise<object> =>
        await this.provisionProject(
            {
                kind: "platform_developer",
                tenantId: access.tenantId,
                subject: access.identity.subject,
                credentialId: "",
            },
            app,
            requestedDisplayName,
            idempotencyKey,
            requestedClientReference,
            locationHint,
            signal,
        );

    readonly provisionAppProject = async (
        principal: PlatformPrincipal,
        appId: string,
        requestedDisplayName: string,
        idempotencyKey: string,
        clientReference: string,
        locationHint: string,
        signal: AbortSignal,
    ): Promise<object> => {
        if (principal.kind === "developer") {
            const result = await this.requireAppDeveloper(principal.identity, appId, signal);
            return await this.createProject(
                result.access,
                result.app,
                requestedDisplayName,
                idempotencyKey,
                clientReference,
                locationHint,
                signal,
            );
        }
        if (
            principal.appId !== appId ||
            principal.scope !== "all-projects" ||
            !PLATFORM_SERVER_PROJECT_PERMISSIONS.every((permission) => principal.permissions.has(permission))
        ) {
            throw new PlatformControlPlaneError(
                "app_provisioning_denied",
                "An App-wide server credential is required",
                403,
            );
        }
        const app = await this.#storage.readApp(principal.appId, signal);
        if (app === null || app.tenant_id !== principal.tenantId || app.lifecycle !== "active") {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        return await this.provisionProject(
            {
                kind: "application",
                tenantId: principal.tenantId,
                subject: principal.appId,
                credentialId: principal.credentialId,
            },
            app,
            requestedDisplayName,
            idempotencyKey,
            clientReference,
            locationHint,
            signal,
        );
    };

    private readonly provisionProject = async (
        access: ProjectProvisioningActor,
        app: AppRow,
        requestedDisplayName: string,
        idempotencyKey: string,
        requestedClientReference: string,
        requestedLocationHint: string,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (access.tenantId !== app.tenant_id || app.lifecycle !== "active") {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        const normalizedIdempotencyKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const clientReference = validateIdentifier(
            requestedClientReference.length > 0 ? requestedClientReference : normalizedIdempotencyKey,
            "client_reference",
        );
        const normalizedDisplayName = displayName(requestedDisplayName);
        const locationHint = validateIdentifier(requestedLocationHint, "location_hint");
        const digest = await requestDigest(normalizedDisplayName, clientReference, locationHint);
        signal.throwIfAborted();
        const existing = await this.#storage.readProjectByIdempotencyKey(app.app_id, normalizedIdempotencyKey, signal);
        if (existing !== null) {
            if (existing.request_digest !== digest) {
                throw new PlatformControlPlaneError(
                    "idempotency_conflict",
                    "The Project idempotency key was used with another request",
                    409,
                );
            }
            return projectResource(existing);
        }
        const placement = this.#placements.resolveLocationHint(locationHint);
        if (placement === null || !this.#placements.supports(placement)) {
            throw new PlatformControlPlaneError(
                "storage_location_unavailable",
                "The requested storage location is unavailable",
                400,
            );
        }
        const tenant = await this.readTenant(access.tenantId, signal);
        const quota = quotasFromRow(tenant);
        const usage = await this.#storage.countActiveProjects(access.tenantId, signal);
        if (!Number.isSafeInteger(usage) || usage < 0) {
            throw new PlatformControlPlaneError("platform_record_invalid", "The Tenant Project usage is invalid", 500);
        }
        if (usage >= quota.activeProjects) {
            await this.recordQuotaDenial(access, "project", app.app_id, quota.activeProjects, signal);
            throw new PlatformControlPlaneError(
                "tenant_project_quota_exceeded",
                "The Tenant active Project quota is exhausted",
                429,
            );
        }
        const now = Date.now();
        const projectId = encodePlatformProjectId(placement, createRandomToken(18));
        const project: ProjectRow = {
            app_id: app.app_id,
            client_reference: clientReference,
            created_at: now,
            deleted_at: null,
            display_name: normalizedDisplayName,
            idempotency_key: normalizedIdempotencyKey,
            lifecycle: "active",
            project_id: projectId,
            request_digest: digest,
            suspended_at: null,
            tenant_id: app.tenant_id,
            updated_at: now,
        };
        const stored = await this.#storage.createProject(
            project,
            quota.activeProjects,
            this.auditRecord(
                access.tenantId,
                app.app_id,
                projectId,
                access.kind,
                access.subject,
                access.credentialId,
                "project.created",
                projectId,
                "succeeded",
                {},
                now,
            ),
            signal,
        );
        if (!stored.projectCreated) {
            const duplicate = await this.#storage.readProjectByIdempotencyKey(
                app.app_id,
                normalizedIdempotencyKey,
                signal,
            );
            if (duplicate !== null && duplicate.request_digest === digest) {
                return projectResource(duplicate);
            }
            await this.recordQuotaDenial(access, "project", app.app_id, quota.activeProjects, signal);
            throw new PlatformControlPlaneError(
                "tenant_project_quota_exceeded",
                "The Tenant active Project quota is exhausted",
                429,
            );
        }
        if (!stored.auditRecorded) {
            throw new PlatformControlPlaneError("platform_write_failed", "The Project could not be created", 503);
        }
        return projectResource(project);
    };

    readonly listApps = async (access: PlatformDeveloperAccess, signal: AbortSignal): Promise<object> => {
        const rows = await this.#storage.listApps(access.tenantId, signal);
        return { apps: rows.map(appResource) };
    };

    readonly listProjects = async (
        access: PlatformDeveloperAccess,
        app: AppRow,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (access.tenantId !== app.tenant_id) {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        const rows = await this.#storage.listProjects(app.app_id, signal);
        return { projects: rows.map(projectResource) };
    };

    readonly readAppResource = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        const result = await this.requireAppDeveloper(identity, appId, signal);
        return appResource(result.app);
    };

    readonly readPlatformConfiguration = async (
        identity: VerifiedExternalIdentity,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (!this.#authentication.operatorSubjects.has(identity.subject)) {
            throw new PlatformControlPlaneError(
                "platform_operator_required",
                "Platform operator authorization is required",
                403,
            );
        }
        return {
            allowedOrigins: Object.freeze([...this.#authentication.allowedOrigins].sort()),
            anonymousPublicBootstrap: false,
            hostingProfile: "platform",
        };
    };

    readonly readTenantUsage = async (access: PlatformDeveloperAccess, signal: AbortSignal): Promise<object> => {
        signal.throwIfAborted();
        const tenant = await this.readTenant(access.tenantId, signal);
        const usage = await this.#storage.readTenantUsage(access.tenantId, signal);
        return {
            ...usage,
            quotas: quotasFromRow(tenant),
            tenantId: access.tenantId,
        };
    };

    readonly listTenantAuditEvents = async (
        access: PlatformDeveloperAccess,
        limit: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new PlatformControlPlaneError("invalid_request", "The audit page size is invalid", 400);
        }
        const rows = await this.#storage.listTenantAuditEvents(access.tenantId, limit, signal);
        return { events: rows.map(auditResource) };
    };

    readonly issueAppCredential = async (
        access: PlatformDeveloperAccess,
        app: AppRow,
        requestedPermissions: unknown,
        projectIds: readonly string[],
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (access.tenantId !== app.tenant_id || app.lifecycle !== "active") {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        const grantedPermissions = appPermissions(requestedPermissions);
        const normalizedProjectIds = await this.validateProjectScope(app.app_id, projectIds, signal);
        const now = Date.now();
        const revision = await this.nextCredentialRevision(app.app_id, signal);
        const created = await this.createCredential(app.app_id, grantedPermissions, revision, now);
        const issued = await this.#storage.issueAppCredential(
            created.storageRecord(normalizedProjectIds.length === 0),
            normalizedProjectIds,
            this.auditRecord(
                access.tenantId,
                app.app_id,
                "",
                "platform_developer",
                access.identity.subject,
                "",
                "app-credential.issued",
                created.credentialId,
                "succeeded",
                { projectIds: normalizedProjectIds },
                now,
            ),
            signal,
        );
        if (!issued) {
            throw new PlatformControlPlaneError("platform_write_failed", "The AppCredential could not be issued", 503);
        }
        return created.resource();
    };

    readonly listAppCredentials = async (
        access: PlatformDeveloperAccess,
        app: AppRow,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (access.tenantId !== app.tenant_id || app.lifecycle !== "active") {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        const rows = await this.#storage.listAppCredentials(app.app_id, signal);
        const credentials = await Promise.all(
            rows.map(async (row) => ({
                allProjects: row.all_projects === 1,
                appId: row.app_id,
                credentialId: row.credential_id,
                issuedAt: iso(row.issued_at),
                lastUsedAt: iso(row.last_used_at),
                overlapEndsAt: typeof row.overlap_ends_at === "number" ? iso(row.overlap_ends_at) : "",
                permissions: permissionValues(permissions(row.permissions_json)),
                projectIds: await this.#storage.listCredentialProjectIds(row.credential_id, signal),
                publicCredentialId: row.public_credential_id,
                replacedByCredentialId: row.replaced_by_credential_id ?? "",
                revision: row.revision,
                revokedAt: typeof row.revoked_at === "number" ? iso(row.revoked_at) : "",
            })),
        );
        return { credentials };
    };

    readonly rotateAppCredential = async (
        identity: VerifiedExternalIdentity,
        credentialId: string,
        overlapSeconds: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const source = await this.readCredentialById(normalizedCredentialId, signal);
        const app = await this.readApp(source.app_id, signal);
        const access = await this.requireTenantDeveloper(identity, app.tenant_id, signal);
        const now = Date.now();
        const created = await this.createCredential(
            source.app_id,
            permissions(source.permissions_json),
            source.revision + 1,
            now,
        );
        const overlapEndsAt = now + overlapMilliseconds(overlapSeconds);
        const rotated = await this.#storage.rotateAppCredential(
            created.storageRecord(source.all_projects === 1),
            source.credential_id,
            overlapEndsAt,
            this.auditRecord(
                app.tenant_id,
                app.app_id,
                "",
                "platform_developer",
                access.identity.subject,
                "",
                "app-credential.rotated",
                source.credential_id,
                "succeeded",
                { replacementCredentialId: created.credentialId },
                now,
            ),
            signal,
        );
        if (!rotated.credentialInserted || !rotated.sourceRotated || !rotated.auditRecorded) {
            throw new PlatformControlPlaneError(
                "app_credential_rotation_conflict",
                "The AppCredential was already rotated or revoked",
                409,
            );
        }
        await this.#appAuthentication.invalidate(source, signal);
        return {
            ...created.resource(),
            overlapEndsAt: iso(overlapEndsAt),
            replacedCredentialId: source.credential_id,
        };
    };

    readonly revokeAppCredential = async (
        identity: VerifiedExternalIdentity,
        credentialId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const source = await this.readCredentialById(normalizedCredentialId, signal);
        const app = await this.readApp(source.app_id, signal);
        const access = await this.requireTenantDeveloper(identity, app.tenant_id, signal);
        const now = Date.now();
        const revoked = await this.#storage.revokeAppCredential(
            normalizedCredentialId,
            now,
            this.auditRecord(
                app.tenant_id,
                app.app_id,
                "",
                "platform_developer",
                access.identity.subject,
                "",
                "app-credential.revoked",
                normalizedCredentialId,
                "succeeded",
                {},
                now,
            ),
            signal,
        );
        if (!revoked.credentialRevoked || !revoked.auditRecorded) {
            throw new PlatformControlPlaneError("app_credential_not_found", "The AppCredential was not found", 404);
        }
        await this.#appAuthentication.invalidate(source, signal);
        return { credentialId: normalizedCredentialId, revokedAt: iso(now) };
    };

    readonly authorize = async (
        credential: ReturnType<typeof decodeProjectCredential>,
        requiredPermission: ProjectPermission,
        actorRef: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        signal.throwIfAborted();
        const row = await this.authenticatedCredential(credential.value, signal);
        const projects = await this.allowedProjects(row, signal);
        if (projects.length !== 1) {
            throw new ProjectAuthenticationError(
                "project_target_required",
                "This AppCredential requires an explicit Project target",
            );
        }
        const projectId = projects[0];
        if (projectId === undefined) {
            throw new ProjectAuthenticationError("project_access_denied", "The AppCredential has no Project access");
        }
        return await this.authorizeCredentialForProject(row, projectId, requiredPermission, actorRef, signal);
    };

    readonly authenticate = async (
        credential: ReturnType<typeof decodeProjectCredential>,
        requiredPermission: ProjectPermission,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => await this.authorize(credential, requiredPermission, "", signal);

    readonly authorizeProject = async (
        projectId: string,
        credentialValue: string,
        requiredPermission: ProjectPermission,
        actorRef: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        signal.throwIfAborted();
        const row = await this.authenticatedCredential(credentialValue, signal);
        return await this.authorizeCredentialForProject(
            row,
            validateIdentifier(projectId, "project_id"),
            requiredPermission,
            actorReference(actorRef),
            signal,
        );
    };

    readonly authorizePlatformCredential = async (
        projectId: string,
        credentialValue: string,
        requiredPermission: ProjectPermission,
        actorRef: string,
        signal: AbortSignal,
    ): Promise<PlatformAppCredentialAccess> => {
        const row = await this.authenticatedCredential(credentialValue, signal);
        const project = await this.authorizeCredentialForProject(
            row,
            validateIdentifier(projectId, "project_id"),
            requiredPermission,
            actorReference(actorRef),
            signal,
        );
        return new PlatformAppCredentialAccess(row.tenant_id, row.app_id, row.revision, project);
    };

    private readonly authorizeCredentialForProject = async (
        row: CredentialRow,
        projectId: string,
        requiredPermission: ProjectPermission,
        _actorRef: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const project = await this.#storage.readProjectScope(projectId, row.app_id, row.tenant_id, signal);
        if (project === null || project.lifecycle !== "active") {
            throw new ProjectAuthenticationError(
                "project_access_denied",
                "The AppCredential is not authorized for this Project",
            );
        }
        if (row.all_projects !== 1) {
            const hasProject = await this.#storage.credentialHasProject(row.credential_id, projectId, signal);
            if (!hasProject) {
                throw new ProjectAuthenticationError(
                    "project_access_denied",
                    "The AppCredential is not authorized for this Project",
                );
            }
        }
        const granted = permissions(row.permissions_json);
        if (!granted.has(requiredPermission)) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The AppCredential does not grant this Project permission",
            );
        }
        const now = Date.now();
        return new ProjectAccessContext(
            new ProjectScope(project.project_id),
            granted,
            new AuditActor(AuditActorKind.Application, row.app_id),
            row.credential_id,
            now,
            new PerpetualProjectAccessLifetime(),
        );
    };

    private readonly authenticatedCredential = async (
        credentialValue: string,
        signal: AbortSignal,
    ): Promise<CredentialRow> => await this.#appAuthentication.verify(credentialValue, signal);

    private readonly allowedProjects = async (row: CredentialRow, signal: AbortSignal): Promise<readonly string[]> => {
        const projects =
            row.all_projects === 1
                ? await this.#storage.listActiveProjectIds(row.app_id, signal)
                : await this.#storage.listScopedActiveProjectIds(row.credential_id, signal);
        return Object.freeze(projects);
    };

    private readonly createCredential = async (
        appId: string,
        grantedPermissions: ReadonlySet<ProjectPermission>,
        revision: number,
        now: number,
    ): Promise<CreatedAppCredential> => {
        const publicCredentialId = createRandomToken(16);
        const credentialId = `pac_${publicCredentialId}`;
        const credential = `mapp_${publicCredentialId}_${createRandomToken(32)}`;
        return new CreatedAppCredential(
            appId,
            credential,
            credentialId,
            publicCredentialId,
            await hashSecret(credential),
            grantedPermissions,
            revision,
            now,
        );
    };

    private readonly nextCredentialRevision = async (appId: string, signal: AbortSignal): Promise<number> => {
        const revision = await this.#storage.nextCredentialRevision(appId, signal);
        if (revision === null || !Number.isSafeInteger(revision) || revision < 1) {
            throw new PlatformControlPlaneError(
                "platform_record_invalid",
                "The AppCredential revision is invalid",
                500,
            );
        }
        return revision;
    };

    private readonly validateProjectScope = async (
        appId: string,
        projectIds: readonly string[],
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        if (projectIds.length > 1_000 || new Set(projectIds).size !== projectIds.length) {
            throw new PlatformControlPlaneError(
                "app_credential_scope_invalid",
                "The AppCredential scope is invalid",
                400,
            );
        }
        const normalized = projectIds.map((projectId) => validateIdentifier(projectId, "project_id"));
        for (const projectId of normalized) {
            const belongsToApp = await this.#storage.projectBelongsToApp(projectId, appId, signal);
            if (!belongsToApp) {
                throw new PlatformControlPlaneError(
                    "app_credential_scope_invalid",
                    "The AppCredential scope contains a Project outside this App",
                    400,
                );
            }
        }
        return Object.freeze(normalized);
    };

    private readonly readApp = async (appId: string, signal: AbortSignal): Promise<AppRow> => {
        const row = await this.#storage.readApp(validateIdentifier(appId, "app_id"), signal);
        if (row === null) {
            throw new PlatformControlPlaneError("app_not_found", "The App was not found", 404);
        }
        return row;
    };

    private readonly readTenant = async (tenantId: string, signal: AbortSignal): Promise<TenantRow> => {
        const row = await this.#storage.readTenant(validateIdentifier(tenantId, "tenant_id"), signal);
        if (row === null || row.lifecycle !== "active") {
            throw new PlatformControlPlaneError("tenant_not_found", "The Tenant was not found", 404);
        }
        return row;
    };

    private readonly recordQuotaDenial = async (
        access: PlatformDeveloperAccess | ProjectProvisioningActor,
        resource: string,
        subjectId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const recorded = await this.#storage.recordAudit(
            this.auditRecord(
                access.tenantId,
                resource === "app" ? "" : subjectId,
                "",
                access instanceof PlatformDeveloperAccess ? "platform_developer" : access.kind,
                access instanceof PlatformDeveloperAccess ? access.identity.subject : access.subject,
                access instanceof PlatformDeveloperAccess ? "" : access.credentialId,
                "quota.denied",
                subjectId,
                "denied",
                { limit, resource },
                Date.now(),
            ),
            signal,
        );
        if (!recorded) {
            throw new PlatformControlPlaneError("platform_write_failed", "The quota denial could not be audited", 503);
        }
    };

    private readonly readCredentialById = async (credentialId: string, signal: AbortSignal): Promise<CredentialRow> => {
        const row = await this.#storage.readCredentialById(credentialId, signal);
        if (row === null) {
            throw new PlatformControlPlaneError("app_credential_not_found", "The AppCredential was not found", 404);
        }
        return row;
    };

    private readonly requireOwner = (access: PlatformDeveloperAccess): void => {
        if (access.role !== "owner") {
            throw new PlatformControlPlaneError("tenant_owner_required", "Tenant owner authorization is required", 403);
        }
    };

    private readonly auditRecord = (
        tenantId: string,
        appId: string,
        projectId: string,
        actorKind: string,
        actorId: string,
        actorRef: string,
        action: string,
        subjectId: string,
        outcome: string,
        details: Readonly<Record<string, unknown>>,
        now: number,
    ): PlatformAuditRecord => ({
        action,
        actorId,
        actorKind,
        actorRef: actorReference(actorRef),
        appId,
        auditId: `pae_${createRandomToken(18)}`,
        detailsJson: JSON.stringify(details),
        outcome,
        projectId,
        recordedAt: now,
        subjectId,
        tenantId,
    });
}
