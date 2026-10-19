import {
    AuditActor,
    createRandomToken,
    type decodeProjectCredential,
    decodeProjectPermissions,
    type ExternalIdentityCredential,
    hashSecret,
    PerpetualProjectAccessLifetime,
    type ProjectAccessAuthorizer,
    ProjectAccessContext,
    type ProjectApplicationResolver,
    ProjectAuthenticationError,
    type ProjectPermission,
    ProjectScope,
    type VerifiedExternalIdentity,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";
import type { ProjectLocationHint } from "@moxt-ai/mobius-sdk/protocol";
import {
    hasControlCharacters,
    PlatformAppCredentialAccess,
    PlatformAuditActorKind,
    type PlatformAuthenticationConfiguration,
    PlatformControlPlaneError,
    PlatformDeveloperAccess,
    type PlatformPrincipal,
    type PlatformProjectPlacementRegistry,
} from "../entity/platform-control-plane.ts";
import {
    decodePlatformProjectPlacement,
    encodePlatformProjectId,
    projectBucketLocation,
} from "../entity/platform-project-id.ts";
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
import type { PlatformProjectAuthorizationStorage } from "../storage/platform-project-authorization-storage.ts";
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

    constructor(activeApps: number, activeProjects: number) {
        if (
            !Number.isSafeInteger(activeApps) ||
            activeApps < 1 ||
            activeApps > 10_000 ||
            !Number.isSafeInteger(activeProjects) ||
            activeProjects < 1 ||
            activeProjects > 100_000
        ) {
            throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
        }
        this.activeApps = activeApps;
        this.activeProjects = activeProjects;
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
        return new TenantQuotas(100, 1_000);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
    }
    const quota = Object.freeze(Object.fromEntries(Object.entries(value)));
    if (
        Object.keys(quota).length !== 2 ||
        !Object.hasOwn(quota, "activeApps") ||
        !Object.hasOwn(quota, "activeProjects")
    ) {
        throw new PlatformControlPlaneError("tenant_quota_invalid", "The Tenant quotas are invalid", 400);
    }
    return new TenantQuotas(quotaValue(quota, "activeApps"), quotaValue(quota, "activeProjects"));
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

async function requestDigest(
    display: string,
    clientReference: string,
    locationHint: ProjectLocationHint,
): Promise<string> {
    return await hashSecret(JSON.stringify({ clientReference, displayName: display, locationHint }));
}

export class PlatformControlPlaneService implements ProjectAccessAuthorizer {
    readonly #authentication: PlatformAuthenticationConfiguration;
    readonly #storage: PlatformControlPlaneStorage;
    readonly #placements: PlatformProjectPlacementRegistry;
    readonly #appAuthentication: AppCredentialAuthenticationService;
    readonly #projectAuthorization: PlatformProjectAuthorizationStorage;

    constructor(
        storage: PlatformControlPlaneStorage,
        authentication: PlatformAuthenticationConfiguration,
        placements: PlatformProjectPlacementRegistry,
        appAuthentication: AppCredentialAuthenticationService,
        projectAuthorization: PlatformProjectAuthorizationStorage,
    ) {
        this.#storage = storage;
        this.#authentication = authentication;
        this.#placements = placements;
        this.#appAuthentication = appAuthentication;
        this.#projectAuthorization = projectAuthorization;
    }

    readonly authenticateDeveloper = async (
        credential: ExternalIdentityCredential,
        signal: AbortSignal,
    ): Promise<VerifiedExternalIdentity> => {
        signal.throwIfAborted();
        try {
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
        return { location: projectBucketLocation(placement.locationHint) };
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
        for (const credential of await this.#storage.listAppCredentials(app.app_id, signal)) {
            await this.#appAuthentication.invalidate(credential, signal);
        }
        return appResource(await this.readApp(app.app_id, signal));
    };

    readonly deleteApp = async (access: PlatformDeveloperAccess, app: AppRow, signal: AbortSignal): Promise<object> => {
        this.requireOwner(access);
        if (access.tenantId !== app.tenant_id || app.lifecycle !== "active") {
            throw new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
        }
        const now = Date.now();
        await this.#projectAuthorization.revokeApp(
            app.app_id,
            (await this.#storage.listProjects(app.app_id, signal)).map((project) => project.project_id),
            signal,
        );
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
        locationHint: ProjectLocationHint,
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
        locationHint: ProjectLocationHint,
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
        requestedLocationHint: ProjectLocationHint,
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
        validateIdentifier(requestedLocationHint, "location_hint");
        const locationHint = requestedLocationHint;
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
            await this.recoverProjectProvisioning(existing, access, signal);
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
            location_hint: placement.locationHint,
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
                await this.recoverProjectProvisioning(duplicate, access, signal);
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
        await this.#projectAuthorization.create(project, signal);
        return projectResource(project);
    };

    readonly listApps = async (access: PlatformDeveloperAccess, signal: AbortSignal): Promise<object> => {
        const rows = await this.#storage.listApps(access.tenantId, signal);
        return { apps: rows.map(appResource) };
    };

    private readonly recoverProjectProvisioning = async (
        project: ProjectRow,
        access: ProjectProvisioningActor,
        signal: AbortSignal,
    ): Promise<void> => {
        const recorded = await this.#storage.recordAudit(
            this.auditRecord(
                project.tenant_id,
                project.app_id,
                project.project_id,
                access.kind,
                access.subject,
                access.credentialId,
                "project.created",
                project.project_id,
                "succeeded",
                {},
                project.created_at,
            ),
            signal,
        );
        if (!recorded) {
            throw new PlatformControlPlaneError("platform_write_failed", "The Project could not be created", 503);
        }
        await this.#projectAuthorization.create(project, signal);
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

    readonly listProjectAuditEvents = async (
        identity: VerifiedExternalIdentity,
        projectId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<object> => {
        const project = await this.#storage.readActiveProjectScope(projectId, signal);
        if (project === null) {
            throw new PlatformControlPlaneError("project_not_found", "The Project is unavailable", 404);
        }
        const access = await this.requireTenantDeveloper(identity, project.tenant_id, signal);
        return await this.listTenantAuditEvents(access, projectId, limit, signal);
    };

    readonly listTenantAuditEvents = async (
        access: PlatformDeveloperAccess,
        projectId: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new PlatformControlPlaneError("invalid_request", "The audit page size is invalid", 400);
        }
        const rows = await this.#storage.listTenantAuditEvents(access.tenantId, projectId, limit, signal);
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
                projectIds:
                    row.all_projects === 1
                        ? []
                        : await this.#storage.listCredentialProjectIds(row.credential_id, signal),
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

    readonly authorizePlatformCredentialRecord = async (
        projectId: string,
        credential: CredentialRow,
        requiredPermission: ProjectPermission,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> =>
        await this.authorizeCredentialForProject(
            credential,
            validateIdentifier(projectId, "project_id"),
            requiredPermission,
            "",
            signal,
        );

    readonly resolveApplicationId: ProjectApplicationResolver["resolveApplicationId"] = async (projectId, signal) => {
        const project = await this.#projectAuthorization.read(validateIdentifier(projectId, "project_id"), signal);
        if (project === null || project.lifecycle !== "active") {
            throw new ProjectAuthenticationError("project_access_denied", "The Project is unavailable");
        }
        return project.app_id;
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
        return new PlatformAppCredentialAccess(row.app_id, row.revision, project);
    };

    private readonly authorizeCredentialForProject = async (
        row: CredentialRow,
        projectId: string,
        requiredPermission: ProjectPermission,
        _actorRef: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const project = await this.#projectAuthorization.read(projectId, signal);
        if (project === null || project.lifecycle !== "active" || project.app_id !== row.app_id) {
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
            new AuditActor(PlatformAuditActorKind.Application, row.app_id),
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
