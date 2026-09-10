import {
    AuditActor,
    AuditActorKind,
    createRandomToken,
    decodeProjectCredential,
    decodeProjectPermissions,
    ExpiringProjectAccessLifetime,
    type ExternalIdentityAuthenticator,
    ExternalIdentityCredential,
    type ExternalIdentityProjectGrant,
    hashSecret,
    type IssuedProjectAccessCredential,
    ProjectAccessContext,
    ProjectAuthenticationError,
    type ProjectAuthenticationService,
    ProjectCredentialScheme,
    type ProjectPermission,
    ProjectScope,
    SessionQuotaPolicy,
    type SessionQuotaPolicyProvider,
    type VerifiedExternalIdentity,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";

const DEFAULT_APP_CREDENTIAL_LIFETIME_MILLISECONDS = 365 * 24 * 60 * 60 * 1_000;
const MINIMUM_APP_CREDENTIAL_LIFETIME_MILLISECONDS = 60 * 1_000;
const MAXIMUM_APP_CREDENTIAL_LIFETIME_MILLISECONDS = 365 * 24 * 60 * 60 * 1_000;
const MAXIMUM_CREDENTIAL_OVERLAP_MILLISECONDS = 60 * 60 * 1_000;

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

interface TenantRow {
    readonly created_at: number;
    readonly deleted_at: unknown;
    readonly display_name: string;
    readonly lifecycle: string;
    readonly quotas_json: string;
    readonly suspended_at: unknown;
    readonly tenant_id: string;
    readonly updated_at: number;
}

interface AppRow {
    readonly app_id: string;
    readonly created_at: number;
    readonly default_credential_id: unknown;
    readonly deleted_at: unknown;
    readonly display_name: string;
    readonly lifecycle: string;
    readonly suspended_at: unknown;
    readonly tenant_id: string;
    readonly updated_at: number;
}

interface ProjectRow {
    readonly app_id: string;
    readonly client_reference: string;
    readonly created_at: number;
    readonly deleted_at: unknown;
    readonly display_name: string;
    readonly idempotency_key: string;
    readonly lifecycle: string;
    readonly project_id: string;
    readonly request_digest: string;
    readonly suspended_at: unknown;
    readonly tenant_id: string;
    readonly updated_at: number;
}

interface CredentialRow {
    readonly all_projects: number;
    readonly app_id: string;
    readonly app_lifecycle: string;
    readonly credential_id: string;
    readonly expires_at: number;
    readonly issued_at: number;
    readonly last_used_at: number;
    readonly overlap_ends_at: unknown;
    readonly permissions_json: string;
    readonly public_credential_id: string;
    readonly replaced_by_credential_id: unknown;
    readonly revision: number;
    readonly revoked_at: unknown;
    readonly secret_digest: string;
    readonly tenant_id: string;
    readonly tenant_lifecycle: string;
}

interface MembershipRow {
    readonly membership_id: string;
    readonly role: string;
    readonly tenant_id: string;
}

interface AuditRow {
    readonly action: string;
    readonly actor_id: string;
    readonly actor_kind: string;
    readonly actor_ref: string;
    readonly app_id: string;
    readonly audit_id: string;
    readonly details_json: string;
    readonly outcome: string;
    readonly project_id: string;
    readonly recorded_at: number;
    readonly subject_id: string;
    readonly tenant_id: string;
}

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

export class PlatformControlPlaneError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PlatformControlPlaneError";
        this.status = status;
    }
}

export class PlatformAuthenticationConfiguration {
    readonly allowedOrigins: ReadonlySet<string>;
    readonly developerAuthenticator: ExternalIdentityAuthenticator;
    readonly operatorSubjects: ReadonlySet<string>;

    constructor(
        developerAuthenticator: ExternalIdentityAuthenticator,
        operatorSubjects: ReadonlySet<string>,
        allowedOrigins: ReadonlySet<string> = new Set(),
    ) {
        if ([...operatorSubjects].some((subject) => !validSubject(subject))) {
            throw new PlatformControlPlaneError(
                "platform_configuration_invalid",
                "A Platform operator subject is invalid",
                500,
            );
        }
        if ([...allowedOrigins].some((origin) => !validOrigin(origin))) {
            throw new PlatformControlPlaneError(
                "platform_configuration_invalid",
                "A Platform browser origin is invalid",
                500,
            );
        }
        this.allowedOrigins = new Set(allowedOrigins);
        this.developerAuthenticator = developerAuthenticator;
        this.operatorSubjects = new Set(operatorSubjects);
    }
}

export class PlatformDeveloperAccess {
    readonly identity: VerifiedExternalIdentity;
    readonly membershipId: string;
    readonly role: string;
    readonly tenantId: string;

    constructor(identity: VerifiedExternalIdentity, membershipId: string, tenantId: string, role: string) {
        this.identity = identity;
        this.membershipId = membershipId;
        this.tenantId = tenantId;
        this.role = role;
    }
}

export class PlatformAppCredentialAccess {
    readonly appId: string;
    readonly credentialRevision: number;
    readonly project: ProjectAccessContext;

    constructor(appId: string, credentialRevision: number, project: ProjectAccessContext) {
        this.appId = appId;
        this.credentialRevision = credentialRevision;
        this.project = project;
    }
}

class CreatedAppCredential {
    readonly appId: string;
    readonly credential: string;
    readonly credentialId: string;
    readonly digest: string;
    readonly expiresAt: number;
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
        expiresAt: number,
    ) {
        this.appId = appId;
        this.credential = credential;
        this.credentialId = credentialId;
        this.publicCredentialId = publicCredentialId;
        this.digest = digest;
        this.permissions = new Set(permissions);
        this.revision = revision;
        this.issuedAt = issuedAt;
        this.expiresAt = expiresAt;
    }

    readonly resource = (): object => ({
        appId: this.appId,
        credential: this.credential,
        credentialId: this.credentialId,
        expiresAt: iso(this.expiresAt),
        issuedAt: iso(this.issuedAt),
        permissions: permissionValues(this.permissions),
        publicCredentialId: this.publicCredentialId,
        revision: this.revision,
    });
}

function validSubject(value: string): boolean {
    return value.length > 0 && value.length <= 256 && !hasControlCharacters(value);
}

function validOrigin(value: string): boolean {
    if (value.length === 0 || value.length > 2_048 || value === "*") {
        return false;
    }
    try {
        const parsed = new URL(value);
        return (
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            parsed.origin === value &&
            parsed.username.length === 0 &&
            parsed.password.length === 0 &&
            parsed.pathname === "/" &&
            parsed.search.length === 0 &&
            parsed.hash.length === 0
        );
    } catch {
        return false;
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

function lifetimeMilliseconds(expiresInSeconds: number): number {
    if (!Number.isSafeInteger(expiresInSeconds)) {
        throw new PlatformControlPlaneError(
            "app_credential_lifetime_invalid",
            "The AppCredential lifetime is invalid",
            400,
        );
    }
    const lifetime = expiresInSeconds * 1_000;
    if (
        lifetime < MINIMUM_APP_CREDENTIAL_LIFETIME_MILLISECONDS ||
        lifetime > MAXIMUM_APP_CREDENTIAL_LIFETIME_MILLISECONDS
    ) {
        throw new PlatformControlPlaneError(
            "app_credential_lifetime_invalid",
            "The AppCredential lifetime is invalid",
            400,
        );
    }
    return lifetime;
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

function constantTimeEqual(left: string, right: string): boolean {
    const maximum = Math.max(left.length, right.length);
    let mismatch = left.length ^ right.length;
    for (let index = 0; index < maximum; index += 1) {
        mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return mismatch === 0;
}

async function requestDigest(display: string, clientReference: string): Promise<string> {
    return await hashSecret(JSON.stringify({ clientReference, displayName: display }));
}

export class D1PlatformControlPlane implements ProjectAuthenticationService, SessionQuotaPolicyProvider {
    readonly #authentication: PlatformAuthenticationConfiguration;
    readonly #database: D1Database;
    readonly #projectDatabase: D1Database;

    constructor(
        database: D1Database,
        authentication: PlatformAuthenticationConfiguration,
        projectDatabase: D1Database,
    ) {
        this.#database = database;
        this.#authentication = authentication;
        this.#projectDatabase = projectDatabase;
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

    readonly createTenant = async (
        identity: VerifiedExternalIdentity,
        requestedDisplayName: string,
        requestedQuotas: unknown,
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
        const now = Date.now();
        const tenantId = `ten_${createRandomToken(18)}`;
        const membershipId = `pdm_${createRandomToken(18)}`;
        const normalizedDisplayName = displayName(requestedDisplayName);
        const quotas = JSON.stringify(tenantQuotas(requestedQuotas));
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO platform_tenants (
                       tenant_id, display_name, lifecycle, quotas_json, created_at, updated_at
                     ) VALUES (?, ?, 'active', ?, ?, ?)`,
                )
                .bind(tenantId, normalizedDisplayName, quotas, now, now),
            this.#database
                .prepare(
                    `INSERT INTO platform_developer_memberships (
                       membership_id, provider_id, issuer, subject, tenant_id, role, created_at
                     ) VALUES (?, ?, ?, ?, ?, 'owner', ?)`,
                )
                .bind(membershipId, identity.providerId, identity.issuer, identity.subject, tenantId, now),
            this.auditStatement(
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
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new PlatformControlPlaneError("platform_write_failed", "The Tenant could not be created", 503);
        }
        return tenantResource({
            created_at: now,
            deleted_at: null,
            display_name: normalizedDisplayName,
            lifecycle: "active",
            quotas_json: quotas,
            suspended_at: null,
            tenant_id: tenantId,
            updated_at: now,
        });
    };

    readonly requireTenantDeveloper = async (
        identity: VerifiedExternalIdentity,
        tenantId: string,
        signal: AbortSignal,
    ): Promise<PlatformDeveloperAccess> => {
        signal.throwIfAborted();
        const normalizedTenantId = validateIdentifier(tenantId, "tenant_id");
        const membership = await this.#database
            .prepare(
                `SELECT memberships.membership_id, memberships.tenant_id, memberships.role
                   FROM platform_developer_memberships AS memberships
                   JOIN platform_tenants AS tenants ON tenants.tenant_id = memberships.tenant_id
                  WHERE memberships.provider_id = ? AND memberships.issuer = ? AND memberships.subject = ?
                    AND memberships.tenant_id = ? AND memberships.revoked_at IS NULL
                    AND tenants.lifecycle = 'active'`,
            )
            .bind(identity.providerId, identity.issuer, identity.subject, normalizedTenantId)
            .first<MembershipRow>();
        signal.throwIfAborted();
        if (membership === null) {
            throw new PlatformControlPlaneError(
                "tenant_access_denied",
                "The developer is not authorized for this Tenant",
                403,
            );
        }
        return new PlatformDeveloperAccess(identity, membership.membership_id, membership.tenant_id, membership.role);
    };

    readonly resolveSessionQuota = async (scope: ProjectScope, signal: AbortSignal): Promise<SessionQuotaPolicy> => {
        const tenantId = scope.storageLocator.resolveHostingPlacement();
        const tenant = await this.readTenant(tenantId, signal);
        const project = await this.#database
            .prepare(
                `SELECT app_id FROM platform_projects
                  WHERE tenant_id = ? AND project_id = ? AND lifecycle = 'active'`,
            )
            .bind(tenantId, scope.projectId)
            .first<{ readonly app_id: string }>();
        signal.throwIfAborted();
        if (project === null) {
            throw new PlatformControlPlaneError("project_not_found", "The Project was not found", 404);
        }
        const quota = quotasFromRow(tenant);
        return new SessionQuotaPolicy(quota.activeSessions, quota.activeSessions);
    };

    readonly recordSessionQuotaDenial = async (
        scope: ProjectScope,
        sessionId: string,
        policy: SessionQuotaPolicy,
        signal: AbortSignal,
    ): Promise<void> => {
        const tenantId = scope.storageLocator.resolveHostingPlacement();
        const project = await this.#database
            .prepare(
                `SELECT app_id FROM platform_projects
                  WHERE tenant_id = ? AND project_id = ? AND lifecycle = 'active'`,
            )
            .bind(tenantId, scope.projectId)
            .first<{ readonly app_id: string }>();
        signal.throwIfAborted();
        if (project === null) {
            throw new PlatformControlPlaneError("project_not_found", "The Project was not found", 404);
        }
        const result = await this.auditStatement(
            tenantId,
            project.app_id,
            scope.projectId,
            "platform_system",
            "session-quota",
            "",
            "quota.denied",
            sessionId,
            "denied",
            { limit: policy.activeSessionsPerTenant, resource: "session" },
            Date.now(),
        ).run();
        signal.throwIfAborted();
        if (result.meta.changes !== 1) {
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
        const usage = await this.#database
            .prepare("SELECT COUNT(*) AS active_count FROM platform_apps WHERE tenant_id = ? AND lifecycle = 'active'")
            .bind(access.tenantId)
            .first<{ readonly active_count: number }>();
        signal.throwIfAborted();
        if (usage === null || !Number.isSafeInteger(usage.active_count) || usage.active_count < 0) {
            throw new PlatformControlPlaneError("platform_record_invalid", "The Tenant App usage is invalid", 500);
        }
        if (usage.active_count >= quota.activeApps) {
            await this.recordQuotaDenial(access, "app", access.tenantId, quota.activeApps, signal);
            throw new PlatformControlPlaneError(
                "tenant_app_quota_exceeded",
                "The Tenant active App quota is exhausted",
                429,
            );
        }
        const appId = `app_${createRandomToken(18)}`;
        const normalizedDisplayName = displayName(requestedDisplayName);
        const created = await this.createCredential(
            appId,
            new Set(PLATFORM_SERVER_PROJECT_PERMISSIONS),
            1,
            now,
            DEFAULT_APP_CREDENTIAL_LIFETIME_MILLISECONDS,
        );
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO platform_apps (
                       app_id, tenant_id, display_name, lifecycle, default_credential_id, created_at, updated_at
                     ) SELECT ?, ?, ?, 'active', ?, ?, ?
                       WHERE (SELECT COUNT(*) FROM platform_apps
                               WHERE tenant_id = ? AND lifecycle = 'active') < ?`,
                )
                .bind(
                    appId,
                    access.tenantId,
                    normalizedDisplayName,
                    created.credentialId,
                    now,
                    now,
                    access.tenantId,
                    quota.activeApps,
                ),
            this.credentialInsertStatement(created, true),
            this.auditCreatedAppStatement(access, appId, now),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1) {
            await this.recordQuotaDenial(access, "app", access.tenantId, quota.activeApps, signal);
            throw new PlatformControlPlaneError(
                "tenant_app_quota_exceeded",
                "The Tenant active App quota is exhausted",
                429,
            );
        }
        if (results.slice(1).some((result) => result.meta.changes !== 1)) {
            throw new PlatformControlPlaneError("platform_write_failed", "The App could not be created", 503);
        }
        const app = appResource({
            app_id: appId,
            created_at: now,
            default_credential_id: created.credentialId,
            deleted_at: null,
            display_name: normalizedDisplayName,
            lifecycle: "active",
            suspended_at: null,
            tenant_id: access.tenantId,
            updated_at: now,
        });
        return { ...app, defaultCredential: created.resource() };
    };

    readonly createProject = async (
        access: PlatformDeveloperAccess,
        app: AppRow,
        requestedDisplayName: string,
        idempotencyKey: string,
        requestedClientReference: string,
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
        const digest = await requestDigest(normalizedDisplayName, clientReference);
        signal.throwIfAborted();
        const existing = await this.#database
            .prepare("SELECT * FROM platform_projects WHERE app_id = ? AND idempotency_key = ?")
            .bind(app.app_id, normalizedIdempotencyKey)
            .first<ProjectRow>();
        signal.throwIfAborted();
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
        const tenant = await this.readTenant(access.tenantId, signal);
        const quota = quotasFromRow(tenant);
        const usage = await this.#database
            .prepare(
                "SELECT COUNT(*) AS active_count FROM platform_projects WHERE tenant_id = ? AND lifecycle = 'active'",
            )
            .bind(access.tenantId)
            .first<{ readonly active_count: number }>();
        signal.throwIfAborted();
        if (usage === null || !Number.isSafeInteger(usage.active_count) || usage.active_count < 0) {
            throw new PlatformControlPlaneError("platform_record_invalid", "The Tenant Project usage is invalid", 500);
        }
        if (usage.active_count >= quota.activeProjects) {
            await this.recordQuotaDenial(access, "project", app.app_id, quota.activeProjects, signal);
            throw new PlatformControlPlaneError(
                "tenant_project_quota_exceeded",
                "The Tenant active Project quota is exhausted",
                429,
            );
        }
        const now = Date.now();
        const projectId = `prj_${createRandomToken(18)}`;
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO platform_projects (
                   project_id, tenant_id, app_id, display_name, client_reference,
                   idempotency_key, request_digest, lifecycle, created_at, updated_at
                 ) SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
                   WHERE (SELECT COUNT(*) FROM platform_projects
                           WHERE tenant_id = ? AND lifecycle = 'active') < ?`,
                )
                .bind(
                    projectId,
                    app.tenant_id,
                    app.app_id,
                    normalizedDisplayName,
                    clientReference,
                    normalizedIdempotencyKey,
                    digest,
                    now,
                    now,
                    access.tenantId,
                    quota.activeProjects,
                ),
            this.auditCreatedProjectStatement(access, app.app_id, projectId, now),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1) {
            const duplicate = await this.#database
                .prepare("SELECT * FROM platform_projects WHERE app_id = ? AND idempotency_key = ?")
                .bind(app.app_id, normalizedIdempotencyKey)
                .first<ProjectRow>();
            signal.throwIfAborted();
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
        if (results.slice(1).some((result) => result.meta.changes !== 1)) {
            throw new PlatformControlPlaneError("platform_write_failed", "The Project could not be created", 503);
        }
        return projectResource({
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
        });
    };

    readonly listApps = async (access: PlatformDeveloperAccess, signal: AbortSignal): Promise<object> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare("SELECT * FROM platform_apps WHERE tenant_id = ? ORDER BY created_at, app_id")
            .bind(access.tenantId)
            .all<AppRow>();
        signal.throwIfAborted();
        return { apps: rows.results.map(appResource) };
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
        const rows = await this.#database
            .prepare("SELECT * FROM platform_projects WHERE app_id = ? ORDER BY created_at, project_id")
            .bind(app.app_id)
            .all<ProjectRow>();
        signal.throwIfAborted();
        return { projects: rows.results.map(projectResource) };
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
        const [apps, projects, sessions] = await Promise.all([
            this.#database
                .prepare(
                    "SELECT COUNT(*) AS active_count FROM platform_apps WHERE tenant_id = ? AND lifecycle = 'active'",
                )
                .bind(access.tenantId)
                .first<{ readonly active_count: number }>(),
            this.#database
                .prepare(
                    "SELECT COUNT(*) AS active_count FROM platform_projects WHERE tenant_id = ? AND lifecycle = 'active'",
                )
                .bind(access.tenantId)
                .first<{ readonly active_count: number }>(),
            this.#projectDatabase
                .prepare("SELECT COUNT(*) AS active_count FROM session_quota_reservations WHERE tenant_id = ?")
                .bind(access.tenantId)
                .first<{ readonly active_count: number }>(),
        ]);
        signal.throwIfAborted();
        if (apps === null || projects === null || sessions === null) {
            throw new PlatformControlPlaneError("platform_record_invalid", "The Tenant usage is unavailable", 500);
        }
        return {
            activeApps: apps.active_count,
            activeProjects: projects.active_count,
            activeSessions: sessions.active_count,
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
        const rows = await this.#database
            .prepare(
                `SELECT * FROM platform_audit_events
                  WHERE tenant_id = ?
                  ORDER BY recorded_at DESC, audit_id DESC
                  LIMIT ?`,
            )
            .bind(access.tenantId, limit)
            .all<AuditRow>();
        signal.throwIfAborted();
        return { events: rows.results.map(auditResource) };
    };

    readonly issueAppCredential = async (
        access: PlatformDeveloperAccess,
        app: AppRow,
        requestedPermissions: unknown,
        projectIds: readonly string[],
        expiresInSeconds: number,
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
        const created = await this.createCredential(
            app.app_id,
            grantedPermissions,
            revision,
            now,
            lifetimeMilliseconds(expiresInSeconds),
        );
        const statements = [this.credentialInsertStatement(created, normalizedProjectIds.length === 0)];
        for (const projectId of normalizedProjectIds) {
            statements.push(
                this.#database
                    .prepare(
                        `INSERT INTO platform_app_credential_projects (credential_id, project_id, created_at)
                         VALUES (?, ?, ?)`,
                    )
                    .bind(created.credentialId, projectId, now),
            );
        }
        statements.push(
            this.auditStatement(
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
        );
        const results = await this.#database.batch(statements);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new PlatformControlPlaneError("platform_write_failed", "The AppCredential could not be issued", 503);
        }
        return created.resource();
    };

    readonly rotateAppCredential = async (
        identity: VerifiedExternalIdentity,
        credentialId: string,
        expiresInSeconds: number,
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
            lifetimeMilliseconds(expiresInSeconds),
        );
        const overlapEndsAt = now + overlapMilliseconds(overlapSeconds);
        const statements = [
            this.credentialInsertStatement(created, source.all_projects === 1),
            this.#database
                .prepare(
                    `INSERT INTO platform_app_credential_projects (credential_id, project_id, created_at)
                     SELECT ?, project_id, ? FROM platform_app_credential_projects WHERE credential_id = ?`,
                )
                .bind(created.credentialId, now, source.credential_id),
            this.#database
                .prepare(
                    `UPDATE platform_app_credentials
                        SET replaced_by_credential_id = ?, overlap_ends_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL AND replaced_by_credential_id IS NULL`,
                )
                .bind(created.credentialId, overlapEndsAt, source.credential_id),
            this.auditStatement(
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
        ];
        const results = await this.#database.batch(statements);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1 || results[3]?.meta.changes !== 1) {
            throw new PlatformControlPlaneError(
                "app_credential_rotation_conflict",
                "The AppCredential was already rotated or revoked",
                409,
            );
        }
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
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    "UPDATE platform_app_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
                )
                .bind(now, normalizedCredentialId),
            this.#database
                .prepare(
                    "UPDATE conversation_access_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE parent_credential_id = ?",
                )
                .bind(now, normalizedCredentialId),
            this.auditStatement(
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
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
            throw new PlatformControlPlaneError("app_credential_not_found", "The AppCredential was not found", 404);
        }
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
        return new PlatformAppCredentialAccess(row.app_id, row.revision, project);
    };

    private readonly authorizeCredentialForProject = async (
        row: CredentialRow,
        projectId: string,
        requiredPermission: ProjectPermission,
        _actorRef: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const project = await this.#database
            .prepare(
                `SELECT project_id, tenant_id, app_id, lifecycle
                   FROM platform_projects
                  WHERE project_id = ? AND app_id = ? AND tenant_id = ?`,
            )
            .bind(projectId, row.app_id, row.tenant_id)
            .first<{
                readonly app_id: string;
                readonly lifecycle: string;
                readonly project_id: string;
                readonly tenant_id: string;
            }>();
        signal.throwIfAborted();
        if (project === null || project.lifecycle !== "active") {
            throw new ProjectAuthenticationError(
                "project_access_denied",
                "The AppCredential is not authorized for this Project",
            );
        }
        if (row.all_projects !== 1) {
            const scope = await this.#database
                .prepare(
                    "SELECT 1 AS present FROM platform_app_credential_projects WHERE credential_id = ? AND project_id = ?",
                )
                .bind(row.credential_id, projectId)
                .first<{ readonly present: number }>();
            signal.throwIfAborted();
            if (scope === null) {
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
        const updated = await this.#database
            .prepare(
                `UPDATE platform_app_credentials SET last_used_at = ?
                  WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?
                    AND (replaced_by_credential_id IS NULL OR overlap_ends_at > ?)`,
            )
            .bind(now, row.credential_id, now, now)
            .run();
        signal.throwIfAborted();
        if (updated.meta.changes !== 1) {
            throw new ProjectAuthenticationError("credential_revoked", "The AppCredential is no longer active");
        }
        return new ProjectAccessContext(
            new ProjectScope(row.tenant_id, project.project_id),
            granted,
            new AuditActor(AuditActorKind.Application, row.app_id),
            row.credential_id,
            now,
            new ExpiringProjectAccessLifetime(row.expires_at),
        );
    };

    private readonly authenticatedCredential = async (
        credentialValue: string,
        signal: AbortSignal,
    ): Promise<CredentialRow> => {
        let credential: ReturnType<typeof decodeProjectCredential>;
        try {
            credential = decodeProjectCredential(credentialValue);
        } catch (cause) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid", {
                cause,
            });
        }
        if (credential.scheme !== ProjectCredentialScheme.Application) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        const row = await this.#database
            .prepare(
                `SELECT credentials.*, apps.tenant_id,
                        apps.lifecycle AS app_lifecycle, tenants.lifecycle AS tenant_lifecycle
                   FROM platform_app_credentials AS credentials
                   JOIN platform_apps AS apps ON apps.app_id = credentials.app_id
                   JOIN platform_tenants AS tenants ON tenants.tenant_id = apps.tenant_id
                  WHERE credentials.public_credential_id = ?`,
            )
            .bind(credential.publicCredentialId)
            .first<CredentialRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        const digest = await hashSecret(credential.value);
        signal.throwIfAborted();
        if (!constantTimeEqual(digest, row.secret_digest)) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The AppCredential is invalid");
        }
        const now = Date.now();
        if (
            row.revoked_at !== null ||
            row.expires_at <= now ||
            (row.replaced_by_credential_id !== null &&
                (typeof row.overlap_ends_at !== "number" || row.overlap_ends_at <= now)) ||
            row.app_lifecycle !== "active" ||
            row.tenant_lifecycle !== "active"
        ) {
            throw new ProjectAuthenticationError("credential_revoked", "The AppCredential is no longer active");
        }
        return row;
    };

    private readonly allowedProjects = async (row: CredentialRow, signal: AbortSignal): Promise<readonly string[]> => {
        const result =
            row.all_projects === 1
                ? await this.#database
                      .prepare("SELECT project_id FROM platform_projects WHERE app_id = ? AND lifecycle = 'active'")
                      .bind(row.app_id)
                      .all<{ readonly project_id: string }>()
                : await this.#database
                      .prepare(
                          `SELECT projects.project_id
                             FROM platform_app_credential_projects AS scopes
                             JOIN platform_projects AS projects ON projects.project_id = scopes.project_id
                            WHERE scopes.credential_id = ? AND projects.lifecycle = 'active'`,
                      )
                      .bind(row.credential_id)
                      .all<{ readonly project_id: string }>();
        signal.throwIfAborted();
        return Object.freeze(result.results.map((project) => project.project_id));
    };

    private readonly createCredential = async (
        appId: string,
        grantedPermissions: ReadonlySet<ProjectPermission>,
        revision: number,
        now: number,
        lifetime: number,
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
            now + lifetime,
        );
    };

    private readonly credentialInsertStatement = (
        created: CreatedAppCredential,
        allProjects: boolean,
    ): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_app_credentials (
                   credential_id, public_credential_id, app_id, secret_digest, permissions_json,
                   all_projects, revision, issued_at, expires_at, last_used_at
                 ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                   WHERE EXISTS (SELECT 1 FROM platform_apps WHERE app_id = ?)`,
            )
            .bind(
                created.credentialId,
                created.publicCredentialId,
                created.appId,
                created.digest,
                JSON.stringify(permissionValues(created.permissions)),
                allProjects ? 1 : 0,
                created.revision,
                created.issuedAt,
                created.expiresAt,
                created.issuedAt,
                created.appId,
            );

    private readonly nextCredentialRevision = async (appId: string, signal: AbortSignal): Promise<number> => {
        const row = await this.#database
            .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM platform_app_credentials WHERE app_id = ?")
            .bind(appId)
            .first<{ readonly revision: number }>();
        signal.throwIfAborted();
        if (row === null || !Number.isSafeInteger(row.revision) || row.revision < 1) {
            throw new PlatformControlPlaneError(
                "platform_record_invalid",
                "The AppCredential revision is invalid",
                500,
            );
        }
        return row.revision;
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
            const row = await this.#database
                .prepare("SELECT 1 AS present FROM platform_projects WHERE project_id = ? AND app_id = ?")
                .bind(projectId, appId)
                .first<{ readonly present: number }>();
            signal.throwIfAborted();
            if (row === null) {
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
        const row = await this.#database
            .prepare("SELECT * FROM platform_apps WHERE app_id = ?")
            .bind(validateIdentifier(appId, "app_id"))
            .first<AppRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PlatformControlPlaneError("app_not_found", "The App was not found", 404);
        }
        return row;
    };

    private readonly readTenant = async (tenantId: string, signal: AbortSignal): Promise<TenantRow> => {
        const row = await this.#database
            .prepare("SELECT * FROM platform_tenants WHERE tenant_id = ?")
            .bind(validateIdentifier(tenantId, "tenant_id"))
            .first<TenantRow>();
        signal.throwIfAborted();
        if (row === null || row.lifecycle !== "active") {
            throw new PlatformControlPlaneError("tenant_not_found", "The Tenant was not found", 404);
        }
        return row;
    };

    private readonly auditCreatedAppStatement = (
        access: PlatformDeveloperAccess,
        appId: string,
        now: number,
    ): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_audit_events (
                   audit_id, tenant_id, app_id, project_id, actor_kind, actor_id,
                   actor_ref, action, subject_id, outcome, details_json, recorded_at
                 ) SELECT ?, ?, ?, '', 'platform_developer', ?, '', 'app.created', ?, 'succeeded', '{}', ?
                   WHERE EXISTS (SELECT 1 FROM platform_apps WHERE app_id = ?)`,
            )
            .bind(`pae_${createRandomToken(18)}`, access.tenantId, appId, access.identity.subject, appId, now, appId);

    private readonly auditCreatedProjectStatement = (
        access: PlatformDeveloperAccess,
        appId: string,
        projectId: string,
        now: number,
    ): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_audit_events (
                   audit_id, tenant_id, app_id, project_id, actor_kind, actor_id,
                   actor_ref, action, subject_id, outcome, details_json, recorded_at
                 ) SELECT ?, ?, ?, ?, 'platform_developer', ?, '', 'project.created', ?, 'succeeded', '{}', ?
                   WHERE EXISTS (SELECT 1 FROM platform_projects WHERE project_id = ?)`,
            )
            .bind(
                `pae_${createRandomToken(18)}`,
                access.tenantId,
                appId,
                projectId,
                access.identity.subject,
                projectId,
                now,
                projectId,
            );

    private readonly recordQuotaDenial = async (
        access: PlatformDeveloperAccess,
        resource: string,
        subjectId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const result = await this.auditStatement(
            access.tenantId,
            resource === "app" ? "" : subjectId,
            "",
            "platform_developer",
            access.identity.subject,
            "",
            "quota.denied",
            subjectId,
            "denied",
            { limit, resource },
            Date.now(),
        ).run();
        signal.throwIfAborted();
        if (result.meta.changes !== 1) {
            throw new PlatformControlPlaneError("platform_write_failed", "The quota denial could not be audited", 503);
        }
    };

    private readonly readCredentialById = async (credentialId: string, signal: AbortSignal): Promise<CredentialRow> => {
        const row = await this.#database
            .prepare(
                `SELECT credentials.*, apps.tenant_id,
                        apps.lifecycle AS app_lifecycle, tenants.lifecycle AS tenant_lifecycle
                   FROM platform_app_credentials AS credentials
                   JOIN platform_apps AS apps ON apps.app_id = credentials.app_id
                   JOIN platform_tenants AS tenants ON tenants.tenant_id = apps.tenant_id
                  WHERE credentials.credential_id = ?`,
            )
            .bind(credentialId)
            .first<CredentialRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PlatformControlPlaneError("app_credential_not_found", "The AppCredential was not found", 404);
        }
        return row;
    };

    private readonly auditStatement = (
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
    ): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO platform_audit_events (
                   audit_id, tenant_id, app_id, project_id, actor_kind, actor_id,
                   actor_ref, action, subject_id, outcome, details_json, recorded_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                `pae_${createRandomToken(18)}`,
                tenantId,
                appId,
                projectId,
                actorKind,
                actorId,
                actorReference(actorRef),
                action,
                subjectId,
                outcome,
                JSON.stringify(details),
                now,
            );

    private readonly unsupportedLegacyOperation = (): never => {
        throw new ProjectAuthenticationError(
            "platform_authentication_plane_required",
            "This credential operation is not available through the shared Project API",
        );
    };

    readonly resolve = async (
        _identity: VerifiedExternalIdentity,
        _signal: AbortSignal,
    ): Promise<readonly ExternalIdentityProjectGrant[]> => this.unsupportedLegacyOperation();

    readonly issue = async (
        _identity: VerifiedExternalIdentity,
        _grant: ExternalIdentityProjectGrant,
        _lifetime: number,
        _signal: AbortSignal,
    ): Promise<IssuedProjectAccessCredential> => this.unsupportedLegacyOperation();

    readonly exchangeExternalIdentity = async (): Promise<IssuedProjectAccessCredential> =>
        this.unsupportedLegacyOperation();

    readonly createApplication = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly listApplications = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly issueApplicationCredential = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly rotateApplicationCredential = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly revokeApplicationCredential = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly revokeApplication = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly attachExternalIdentity = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly listExternalIdentityBindings = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly revokeExternalIdentityBinding = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly listOwnerCredentials = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly rotateOwnerCredential = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly revokeOwnerCredential = async (): Promise<object> => this.unsupportedLegacyOperation();
    readonly listAuditEvents = async (): Promise<object> => this.unsupportedLegacyOperation();
}
