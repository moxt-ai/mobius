import {
    AuditActor,
    AuditActorKind,
    createRandomToken,
    decodeProjectCredential,
    decodeProjectPermissions,
    ExpiringProjectAccessLifetime,
    type ExternalIdentityAuthenticator,
    ExternalIdentityCredential,
    ExternalIdentityProjectGrant,
    hashSecret,
    INTERACTIVE_PROJECT_PERMISSIONS,
    IssuedProjectAccessCredential,
    PerpetualProjectAccessLifetime,
    PROJECT_PERMISSIONS,
    ProjectAccessContext,
    ProjectAuthenticationError,
    type ProjectAuthenticationService,
    type ProjectCredential,
    ProjectCredentialScheme,
    type ProjectPermission,
    ProjectScope,
    type VerifiedExternalIdentity,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";

const ACCESS_CREDENTIAL_MAXIMUM_LIFETIME_MILLISECONDS = 15 * 60 * 1_000;
const ACCESS_CREDENTIAL_MINIMUM_LIFETIME_MILLISECONDS = 60 * 1_000;
const APPLICATION_CREDENTIAL_MAXIMUM_LIFETIME_MILLISECONDS = 365 * 24 * 60 * 60 * 1_000;
const APPLICATION_CREDENTIAL_MINIMUM_LIFETIME_MILLISECONDS = 60 * 1_000;
const CREDENTIAL_OVERLAP_MAXIMUM_MILLISECONDS = 60 * 60 * 1_000;
const EXTERNAL_IDENTITY_FRESHNESS_MILLISECONDS = 5 * 60 * 1_000;
const MAXIMUM_AUDIT_PAGE_SIZE = 100;

interface CapabilityCredentialRow {
    readonly actor_id: string;
    readonly actor_kind: string;
    readonly credential_id: string;
    readonly expires_at: unknown;
    readonly overlap_ends_at: unknown;
    readonly project_id: string;
    readonly replaced_by_credential_id: unknown;
    readonly revoked_at: unknown;
    readonly source: string;
    readonly source_status: string;
}

interface ApplicationCredentialRow {
    readonly application_id: string;
    readonly credential_id: string;
    readonly expires_at: number;
    readonly lifecycle: string;
    readonly overlap_ends_at: unknown;
    readonly permissions_json: string;
    readonly project_id: string;
    readonly replaced_by_credential_id: unknown;
    readonly revoked_at: unknown;
    readonly tenant_id: string;
}

interface AccessCredentialRow {
    readonly credential_id: string;
    readonly expires_at: number;
    readonly grant_id: string;
    readonly grant_revoked_at: unknown;
    readonly permissions_json: string;
    readonly project_id: string;
    readonly revoked_at: unknown;
    readonly tenant_id: string;
}

interface ApplicationRow {
    readonly application_id: string;
    readonly created_at: number;
    readonly lifecycle: string;
    readonly name: string;
    readonly permissions_json: string;
    readonly project_id: string;
    readonly revoked_at: unknown;
    readonly tenant_id: string;
    readonly updated_at: number;
}

interface ApplicationCredentialResourceRow {
    readonly credential_id: string;
    readonly expires_at: number;
    readonly issued_at: number;
    readonly last_used_at: number;
    readonly overlap_ends_at: unknown;
    readonly public_credential_id: string;
    readonly replaced_by_credential_id: unknown;
    readonly revoked_at: unknown;
}

interface ExternalGrantRow {
    readonly binding_id: string;
    readonly grant_id: string;
    readonly permissions_json: string;
    readonly project_id: string;
    readonly tenant_id: string;
}

interface ExternalBindingRow extends ExternalGrantRow {
    readonly created_at: number;
    readonly issuer: string;
    readonly last_verified_at: number;
    readonly provider_id: string;
    readonly subject: string;
}

interface OwnerCredentialRow {
    readonly credential_id: string;
    readonly created_at: number;
    readonly last_used_at: number;
    readonly overlap_ends_at: unknown;
    readonly replaced_by_credential_id: unknown;
    readonly revoked_at: unknown;
    readonly source_channel_id: string;
}

function encodedPermissions(permissions: ReadonlySet<ProjectPermission>): string {
    return JSON.stringify([...permissions].map((permission) => permission.value).sort());
}

function permissionsFromRow(encoded: string): ReadonlySet<ProjectPermission> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new ProjectAuthenticationError(
            "project_authorization_record_invalid",
            "The stored Project authorization is invalid",
            { cause },
        );
    }
    try {
        return decodeProjectPermissions(value);
    } catch (cause) {
        throw new ProjectAuthenticationError(
            "project_authorization_record_invalid",
            "The stored Project authorization is invalid",
            { cause },
        );
    }
}

function iso(epochMilliseconds: number): string {
    return new Date(epochMilliseconds).toISOString();
}

function actorKind(value: string): AuditActorKind {
    if (value === AuditActorKind.AccountlessOwner.value) {
        return AuditActorKind.AccountlessOwner;
    }
    if (value === AuditActorKind.Application.value) {
        return AuditActorKind.Application;
    }
    if (value === AuditActorKind.BrowserAccess.value) {
        return AuditActorKind.BrowserAccess;
    }
    if (value === AuditActorKind.ExternalIdentity.value) {
        return AuditActorKind.ExternalIdentity;
    }
    throw new ProjectAuthenticationError(
        "project_authorization_record_invalid",
        "The stored Project authorization is invalid",
    );
}

function sanitizedActorReference(value: string): string {
    let withoutControls = "";
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint > 31 && codePoint !== 127) {
            withoutControls += character;
        }
    }
    return withoutControls.replace(/\s+/g, " ").trim().slice(0, 200);
}

function ensurePermissionSubset(
    requested: ReadonlySet<ProjectPermission>,
    granted: ReadonlySet<ProjectPermission>,
): void {
    for (const permission of requested) {
        if (!granted.has(permission)) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The requested Project permission is not granted",
            );
        }
    }
}

function applicationResource(row: ApplicationRow, credentials: readonly ApplicationCredentialResourceRow[]): object {
    if (
        (row.lifecycle === "active" && row.revoked_at !== null) ||
        (row.lifecycle === "revoked" && typeof row.revoked_at !== "number") ||
        (row.lifecycle !== "active" && row.lifecycle !== "revoked")
    ) {
        throw new ProjectAuthenticationError(
            "project_authorization_record_invalid",
            "The stored Project application is invalid",
        );
    }
    return {
        applicationId: row.application_id,
        createdAt: iso(row.created_at),
        credentials: credentials.map(applicationCredentialResource),
        lifecycle: row.lifecycle,
        name: row.name,
        permissions: [...permissionsFromRow(row.permissions_json)].map((permission) => permission.value),
        projectId: row.project_id,
        revokedAt: typeof row.revoked_at === "number" ? iso(row.revoked_at) : "",
        updatedAt: iso(row.updated_at),
    };
}

function credentialLifecycleResource(
    replacedByCredentialId: unknown,
    overlapEndsAt: unknown,
    revokedAt: unknown,
): Readonly<Record<string, string>> {
    const hasReplacement = typeof replacedByCredentialId === "string";
    const hasOverlap = typeof overlapEndsAt === "number";
    if (
        hasReplacement !== hasOverlap ||
        (replacedByCredentialId !== null && !hasReplacement) ||
        (overlapEndsAt !== null && !hasOverlap) ||
        (revokedAt !== null && typeof revokedAt !== "number")
    ) {
        throw new ProjectAuthenticationError(
            "project_authorization_record_invalid",
            "The stored Project credential lifecycle is invalid",
        );
    }
    return {
        overlapEndsAt: hasOverlap ? iso(overlapEndsAt) : "",
        replacedByCredentialId: hasReplacement ? replacedByCredentialId : "",
        revokedAt: typeof revokedAt === "number" ? iso(revokedAt) : "",
    };
}

function applicationCredentialResource(row: ApplicationCredentialResourceRow): object {
    return {
        credentialId: row.credential_id,
        expiresAt: iso(row.expires_at),
        issuedAt: iso(row.issued_at),
        lastUsedAt: iso(row.last_used_at),
        publicCredentialId: row.public_credential_id,
        ...credentialLifecycleResource(row.replaced_by_credential_id, row.overlap_ends_at, row.revoked_at),
    };
}

function externalBindingResource(row: ExternalBindingRow): object {
    return {
        bindingId: row.binding_id,
        createdAt: iso(row.created_at),
        grantId: row.grant_id,
        issuer: row.issuer,
        lastVerifiedAt: iso(row.last_verified_at),
        permissions: [...permissionsFromRow(row.permissions_json)].map((permission) => permission.value),
        projectId: row.project_id,
        providerId: row.provider_id,
        subject: row.subject,
    };
}

export class D1ProjectAuthentication implements ProjectAuthenticationService {
    readonly #database: D1Database;
    readonly #tenantId: string;

    constructor(database: D1Database, tenantId: string) {
        this.#database = database;
        this.#tenantId = tenantId;
    }

    readonly authorize = async (
        credential: ProjectCredential,
        requiredPermission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        signal.throwIfAborted();
        if (credential.scheme === ProjectCredentialScheme.Application) {
            return await this.authenticateApplicationCredential(credential, requiredPermission, actorReference, signal);
        }
        if (credential.scheme === ProjectCredentialScheme.Access) {
            return await this.authenticateAccessCredential(credential, requiredPermission, actorReference, signal);
        }
        if (credential.scheme === ProjectCredentialScheme.Capability) {
            return await this.authenticateCapabilityCredential(credential, requiredPermission, actorReference, signal);
        }
        throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
    };

    readonly authenticate = async (
        credential: ProjectCredential,
        requiredPermission: ProjectPermission,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => await this.authorize(credential, requiredPermission, "", signal);

    readonly authorizeProject = async (
        projectId: string,
        credentialValue: string,
        permission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        const access = await this.authorize(
            decodeProjectCredential(credentialValue),
            permission,
            actorReference,
            signal,
        );
        if (access.scope.projectId !== normalizedProjectId) {
            await this.recordAudit(
                access.scope,
                access.actor,
                actorReference,
                "project.authorization",
                normalizedProjectId,
                "denied",
                { permission: permission.value, reason: "project_scope_mismatch" },
                Date.now(),
                signal,
            );
            throw new ProjectAuthenticationError(
                "project_access_denied",
                "The credential is not authorized for this Project",
            );
        }
        return access;
    };

    readonly resolve = async (
        identity: VerifiedExternalIdentity,
        signal: AbortSignal,
    ): Promise<readonly ExternalIdentityProjectGrant[]> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(
                `SELECT bindings.binding_id, grants.grant_id, grants.tenant_id,
                        grants.project_id, grants.permissions_json
                   FROM external_identity_bindings AS bindings
                   INNER JOIN external_identity_project_grants AS grants
                     ON grants.binding_id = bindings.binding_id
                  WHERE bindings.provider_id = ? AND bindings.issuer = ? AND bindings.subject = ?
                    AND grants.revoked_at IS NULL
                  ORDER BY grants.created_at, grants.grant_id`,
            )
            .bind(identity.providerId, identity.issuer, identity.subject)
            .all<ExternalGrantRow>();
        signal.throwIfAborted();
        return rows.results.map(
            (row) =>
                new ExternalIdentityProjectGrant(
                    row.binding_id,
                    row.grant_id,
                    new ProjectScope(row.project_id),
                    permissionsFromRow(row.permissions_json),
                ),
        );
    };

    readonly issue = async (
        identity: VerifiedExternalIdentity,
        grant: ExternalIdentityProjectGrant,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ): Promise<IssuedProjectAccessCredential> => {
        signal.throwIfAborted();
        if (
            !Number.isSafeInteger(lifetimeMilliseconds) ||
            lifetimeMilliseconds < ACCESS_CREDENTIAL_MINIMUM_LIFETIME_MILLISECONDS ||
            lifetimeMilliseconds > ACCESS_CREDENTIAL_MAXIMUM_LIFETIME_MILLISECONDS
        ) {
            throw new ProjectAuthenticationError(
                "access_credential_lifetime_invalid",
                "The Mobius access credential lifetime is invalid",
            );
        }
        const now = Date.now();
        const expiresAt = Math.min(now + lifetimeMilliseconds, identity.expiresAtEpochMilliseconds);
        if (expiresAt <= now) {
            throw new ProjectAuthenticationError(
                "external_identity_expired",
                "The external identity credential has expired",
            );
        }
        const publicCredentialId = createRandomToken(16);
        const credentialId = `mac_${publicCredentialId}`;
        const credential = `maccess_${publicCredentialId}_${createRandomToken(32)}`;
        const stored = await this.#database
            .prepare(
                `INSERT INTO mobius_access_credentials (
                   credential_id, public_credential_id, grant_id, tenant_id, project_id,
                   secret_digest, permissions_json, issued_at, expires_at, last_used_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                credentialId,
                publicCredentialId,
                grant.grantId,
                this.#tenantId,
                grant.scope.projectId,
                await hashSecret(credential),
                encodedPermissions(grant.permissions),
                now,
                expiresAt,
                now,
            )
            .run();
        signal.throwIfAborted();
        if (stored.meta.changes !== 1) {
            throw new ProjectAuthenticationError(
                "project_authentication_unavailable",
                "The Mobius access credential could not be issued",
            );
        }
        await this.recordAudit(
            grant.scope,
            new AuditActor(AuditActorKind.ExternalIdentity, grant.bindingId),
            "",
            "access-credential.issued",
            credentialId,
            "succeeded",
            { expiresAt: iso(expiresAt), providerId: identity.providerId },
            now,
            signal,
        );
        return new IssuedProjectAccessCredential(credential, credentialId, grant.scope, grant.permissions, expiresAt);
    };

    readonly exchangeExternalIdentity = async (
        providerId: string,
        externalCredential: string,
        projectId: string,
        lifetimeMilliseconds: number,
        authenticator: ExternalIdentityAuthenticator,
        signal: AbortSignal,
    ): Promise<IssuedProjectAccessCredential> => {
        const identity = await authenticator.authenticate(
            new ExternalIdentityCredential(validateIdentifier(providerId, "provider_id"), externalCredential),
            signal,
        );
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        const grants = await this.resolve(identity, signal);
        const grant = grants.find((candidate) => candidate.scope.projectId === normalizedProjectId);
        if (grant === undefined) {
            throw new ProjectAuthenticationError(
                "external_identity_not_granted",
                "The external identity has no grant for this Project",
            );
        }
        return await this.issue(identity, grant, lifetimeMilliseconds, signal);
    };

    readonly createApplication = async (
        access: ProjectAccessContext,
        name: string,
        permissions: ReadonlySet<ProjectPermission>,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        ensurePermissionSubset(permissions, access.permissions);
        const now = Date.now();
        const applicationId = `app_${createRandomToken(18)}`;
        const stored = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO project_applications (
                       application_id, tenant_id, project_id, name, permissions_json,
                       lifecycle, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
                )
                .bind(
                    applicationId,
                    this.#tenantId,
                    access.scope.projectId,
                    name,
                    encodedPermissions(permissions),
                    now,
                    now,
                ),
            this.auditStatement(
                access.scope,
                access.actor,
                "",
                "project-application.created",
                applicationId,
                "succeeded",
                { permissions: [...permissions].map((permission) => permission.value) },
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (stored.some((result) => result.meta.changes !== 1)) {
            throw new ProjectAuthenticationError(
                "project_application_conflict",
                "The Project application could not be created",
            );
        }
        return {
            applicationId,
            createdAt: iso(now),
            credentials: [],
            lifecycle: "active",
            name,
            permissions: [...permissions].map((permission) => permission.value),
            projectId: access.scope.projectId,
            revokedAt: "",
            updatedAt: iso(now),
        };
    };

    readonly listApplications = async (access: ProjectAccessContext, signal: AbortSignal): Promise<object> => {
        signal.throwIfAborted();
        const applications = await this.#database
            .prepare(
                `SELECT * FROM project_applications
                  WHERE tenant_id = ? AND project_id = ?
                  ORDER BY created_at DESC, application_id DESC`,
            )
            .bind(this.#tenantId, access.scope.projectId)
            .all<ApplicationRow>();
        const resources: object[] = [];
        for (const application of applications.results) {
            const credentials = await this.#database
                .prepare(
                    `SELECT credential_id, public_credential_id, issued_at, expires_at,
                            last_used_at, overlap_ends_at, replaced_by_credential_id, revoked_at
                       FROM project_application_credentials
                      WHERE application_id = ?
                      ORDER BY issued_at DESC, credential_id DESC`,
                )
                .bind(application.application_id)
                .all<ApplicationCredentialResourceRow>();
            signal.throwIfAborted();
            resources.push(applicationResource(application, credentials.results));
        }
        return { applications: resources };
    };

    readonly issueApplicationCredential = async (
        access: ProjectAccessContext,
        applicationId: string,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        this.validateApplicationCredentialLifetime(lifetimeMilliseconds);
        const application = await this.readActiveApplication(access.scope, applicationId, signal);
        const now = Date.now();
        return await this.insertApplicationCredential(access, application, lifetimeMilliseconds, now, signal);
    };

    readonly rotateApplicationCredential = async (
        access: ProjectAccessContext,
        credentialId: string,
        lifetimeMilliseconds: number,
        overlapMilliseconds: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        this.validateApplicationCredentialLifetime(lifetimeMilliseconds);
        if (
            !Number.isSafeInteger(overlapMilliseconds) ||
            overlapMilliseconds < 0 ||
            overlapMilliseconds > CREDENTIAL_OVERLAP_MAXIMUM_MILLISECONDS
        ) {
            throw new ProjectAuthenticationError(
                "credential_overlap_invalid",
                "The credential overlap period is invalid",
            );
        }
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const application = await this.#database
            .prepare(
                `SELECT applications.*
                   FROM project_applications AS applications
                   INNER JOIN project_application_credentials AS credentials
                     ON credentials.application_id = applications.application_id
                  WHERE credentials.credential_id = ?
                    AND credentials.revoked_at IS NULL
                    AND applications.tenant_id = ? AND applications.project_id = ?
                    AND applications.lifecycle = 'active'`,
            )
            .bind(normalizedCredentialId, this.#tenantId, access.scope.projectId)
            .first<ApplicationRow>();
        signal.throwIfAborted();
        if (application === null) {
            throw new ProjectAuthenticationError(
                "application_credential_not_found",
                "The Project application credential was not found",
            );
        }
        const now = Date.now();
        const replacement = await this.createApplicationCredential(application, lifetimeMilliseconds, now);
        const overlapEndsAt = now + overlapMilliseconds;
        const stored = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO project_application_credentials (
                       credential_id, public_credential_id, application_id, secret_digest,
                       issued_at, expires_at, last_used_at
                     )
                     SELECT ?, ?, ?, ?, ?, ?, ?
                     FROM project_application_credentials AS source
                     INNER JOIN project_applications AS applications
                       ON applications.application_id = source.application_id
                     WHERE source.credential_id = ?
                       AND source.application_id = ?
                       AND source.revoked_at IS NULL
                       AND source.replaced_by_credential_id IS NULL
                       AND applications.tenant_id = ?
                       AND applications.project_id = ?
                       AND applications.lifecycle = 'active'`,
                )
                .bind(
                    replacement.credentialId,
                    replacement.publicCredentialId,
                    application.application_id,
                    replacement.digest,
                    now,
                    replacement.expiresAt,
                    now,
                    normalizedCredentialId,
                    application.application_id,
                    this.#tenantId,
                    access.scope.projectId,
                ),
            this.#database
                .prepare(
                    `UPDATE project_application_credentials
                        SET replaced_by_credential_id = ?, overlap_ends_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL
                        AND replaced_by_credential_id IS NULL
                        AND EXISTS (
                          SELECT 1 FROM project_application_credentials AS replacement
                           WHERE replacement.credential_id = ?
                             AND replacement.application_id = project_application_credentials.application_id
                        )`,
                )
                .bind(replacement.credentialId, overlapEndsAt, normalizedCredentialId, replacement.credentialId),
            this.#database
                .prepare(
                    `INSERT INTO authentication_audit_events (
                       audit_id, tenant_id, project_id, actor_kind, actor_id, actor_ref,
                       action, subject_id, outcome, details_json, recorded_at
                     )
                     SELECT ?, ?, ?, ?, ?, '', ?, ?, 'succeeded', ?, ?
                     WHERE EXISTS (
                       SELECT 1 FROM project_application_credentials WHERE credential_id = ?
                     )`,
                )
                .bind(
                    `aae_${createRandomToken(18)}`,
                    this.#tenantId,
                    access.scope.projectId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "project-application-credential.rotated",
                    normalizedCredentialId,
                    JSON.stringify({
                        overlapEndsAt: iso(overlapEndsAt),
                        replacementCredentialId: replacement.credentialId,
                    }),
                    now,
                    replacement.credentialId,
                ),
        ]);
        signal.throwIfAborted();
        if (stored.some((result) => result.meta.changes !== 1)) {
            throw new ProjectAuthenticationError(
                "application_credential_rotation_conflict",
                "The Project application credential could not be rotated",
            );
        }
        return {
            ...replacement.resource,
            overlapEndsAt: iso(overlapEndsAt),
            replacedCredentialId: normalizedCredentialId,
        };
    };

    readonly revokeApplicationCredential = async (
        access: ProjectAccessContext,
        credentialId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const now = Date.now();
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE project_application_credentials
                        SET revoked_at = COALESCE(revoked_at, ?)
                      WHERE credential_id = ? AND application_id IN (
                        SELECT application_id FROM project_applications
                         WHERE tenant_id = ? AND project_id = ?
                      )`,
                )
                .bind(now, normalizedCredentialId, this.#tenantId, access.scope.projectId),
            this.#database
                .prepare(
                    `INSERT INTO authentication_audit_events (
                       audit_id, tenant_id, project_id, actor_kind, actor_id, actor_ref,
                       action, subject_id, outcome, details_json, recorded_at
                     )
                     SELECT ?, ?, ?, ?, ?, '', ?, ?, 'succeeded', '{}', ?
                     WHERE EXISTS (
                       SELECT 1
                         FROM project_application_credentials AS credentials
                         INNER JOIN project_applications AS applications
                           ON applications.application_id = credentials.application_id
                        WHERE credentials.credential_id = ?
                          AND applications.tenant_id = ? AND applications.project_id = ?
                     )`,
                )
                .bind(
                    `aae_${createRandomToken(18)}`,
                    this.#tenantId,
                    access.scope.projectId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "project-application-credential.revoked",
                    normalizedCredentialId,
                    now,
                    normalizedCredentialId,
                    this.#tenantId,
                    access.scope.projectId,
                ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new ProjectAuthenticationError(
                "application_credential_not_found",
                "The Project application credential was not found",
            );
        }
        return { credentialId: normalizedCredentialId, revokedAt: iso(now) };
    };

    readonly revokeApplication = async (
        access: ProjectAccessContext,
        applicationId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedApplicationId = validateIdentifier(applicationId, "application_id");
        const now = Date.now();
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE project_applications
                        SET lifecycle = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
                      WHERE application_id = ? AND tenant_id = ? AND project_id = ?`,
                )
                .bind(now, now, normalizedApplicationId, this.#tenantId, access.scope.projectId),
            this.#database
                .prepare(
                    `UPDATE project_application_credentials
                        SET revoked_at = COALESCE(revoked_at, ?)
                      WHERE application_id = ? AND revoked_at IS NULL
                        AND application_id IN (
                          SELECT application_id FROM project_applications
                           WHERE tenant_id = ? AND project_id = ?
                        )`,
                )
                .bind(now, normalizedApplicationId, this.#tenantId, access.scope.projectId),
            this.#database
                .prepare(
                    `INSERT INTO authentication_audit_events (
                       audit_id, tenant_id, project_id, actor_kind, actor_id, actor_ref,
                       action, subject_id, outcome, details_json, recorded_at
                     )
                     SELECT ?, ?, ?, ?, ?, '', ?, ?, 'succeeded', '{}', ?
                     WHERE EXISTS (
                       SELECT 1 FROM project_applications
                        WHERE application_id = ? AND tenant_id = ? AND project_id = ?
                     )`,
                )
                .bind(
                    `aae_${createRandomToken(18)}`,
                    this.#tenantId,
                    access.scope.projectId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "project-application.revoked",
                    normalizedApplicationId,
                    now,
                    normalizedApplicationId,
                    this.#tenantId,
                    access.scope.projectId,
                ),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
            throw new ProjectAuthenticationError(
                "project_application_not_found",
                "The Project application was not found",
            );
        }
        return { applicationId: normalizedApplicationId, revokedAt: iso(now) };
    };

    readonly attachExternalIdentity = async (
        access: ProjectAccessContext,
        identity: VerifiedExternalIdentity,
        permissions: ReadonlySet<ProjectPermission>,
        revokeOwnerCredential: boolean,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (access.actor.kind !== AuditActorKind.AccountlessOwner) {
            throw new ProjectAuthenticationError(
                "owner_access_required",
                "An accountless owner credential is required to attach an external identity",
            );
        }
        ensurePermissionSubset(permissions, access.permissions);
        const now = Date.now();
        if (
            identity.authenticatedAtEpochMilliseconds > now ||
            now - identity.authenticatedAtEpochMilliseconds > EXTERNAL_IDENTITY_FRESHNESS_MILLISECONDS ||
            identity.expiresAtEpochMilliseconds <= now
        ) {
            throw new ProjectAuthenticationError(
                "external_identity_not_fresh",
                "A fresh external identity proof is required",
            );
        }
        const existing = await this.#database
            .prepare(
                `SELECT binding_id FROM external_identity_bindings
                  WHERE provider_id = ? AND issuer = ? AND subject = ?`,
            )
            .bind(identity.providerId, identity.issuer, identity.subject)
            .first<{ readonly binding_id: string }>();
        signal.throwIfAborted();
        const bindingId = existing?.binding_id ?? `eib_${createRandomToken(18)}`;
        const grantId = `eig_${createRandomToken(18)}`;
        const statements: D1PreparedStatement[] = [];
        if (existing === null) {
            statements.push(
                this.#database
                    .prepare(
                        `INSERT INTO external_identity_bindings (
                           binding_id, provider_id, issuer, subject, metadata_json,
                           created_at, last_verified_at
                         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .bind(
                        bindingId,
                        identity.providerId,
                        identity.issuer,
                        identity.subject,
                        JSON.stringify(Object.fromEntries(identity.metadata)),
                        now,
                        now,
                    ),
            );
        } else {
            statements.push(
                this.#database
                    .prepare(
                        `UPDATE external_identity_bindings
                            SET metadata_json = ?, last_verified_at = ?
                          WHERE binding_id = ?`,
                    )
                    .bind(JSON.stringify(Object.fromEntries(identity.metadata)), now, bindingId),
            );
        }
        statements.push(
            this.#database
                .prepare(
                    `INSERT INTO external_identity_project_grants (
                       grant_id, binding_id, tenant_id, project_id, permissions_json,
                       created_by_actor_kind, created_by_actor_id, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    grantId,
                    bindingId,
                    this.#tenantId,
                    access.scope.projectId,
                    encodedPermissions(permissions),
                    access.actor.kind.value,
                    access.actor.actorId,
                    now,
                ),
        );
        if (revokeOwnerCredential) {
            statements.push(
                this.#database
                    .prepare(
                        `UPDATE project_owner_credentials SET revoked_at = COALESCE(revoked_at, ?)
                          WHERE credential_id = ? AND project_id = ?`,
                    )
                    .bind(now, access.credentialId, access.scope.projectId),
            );
            statements.push(
                this.#database
                    .prepare(
                        `UPDATE channel_host_credentials SET revoked_at = COALESCE(revoked_at, ?)
                          WHERE credential_id = ? AND channel_id IN (
                            SELECT source_channel_id FROM project_owner_credentials
                             WHERE credential_id = ? AND project_id = ?
                          )`,
                    )
                    .bind(now, access.credentialId, access.credentialId, access.scope.projectId),
            );
        }
        statements.push(
            this.auditStatement(
                access.scope,
                access.actor,
                "",
                "external-identity-binding.attached",
                bindingId,
                "succeeded",
                {
                    grantId,
                    ownerCredentialRevoked: revokeOwnerCredential,
                    permissions: [...permissions].map((permission) => permission.value),
                },
                now,
            ),
        );
        const results = await this.storeExternalIdentityAttachment(statements, identity, access.scope, signal);
        signal.throwIfAborted();
        const auditResultIndex = revokeOwnerCredential ? 4 : 2;
        const ownerCredentialChanged = !revokeOwnerCredential || results[2]?.meta.changes === 1;
        if (
            results[0]?.meta.changes !== 1 ||
            results[1]?.meta.changes !== 1 ||
            !ownerCredentialChanged ||
            results[auditResultIndex]?.meta.changes !== 1
        ) {
            throw new ProjectAuthenticationError(
                "external_identity_binding_conflict",
                "The external identity could not be attached",
            );
        }
        return {
            bindingId,
            createdAt: iso(now),
            grantId,
            issuer: identity.issuer,
            lastVerifiedAt: iso(now),
            ownerCredentialRevoked: revokeOwnerCredential,
            permissions: [...permissions].map((permission) => permission.value),
            projectId: access.scope.projectId,
            providerId: identity.providerId,
            subject: identity.subject,
        };
    };

    private readonly storeExternalIdentityAttachment = async (
        statements: D1PreparedStatement[],
        identity: VerifiedExternalIdentity,
        scope: ProjectScope,
        signal: AbortSignal,
    ) => {
        try {
            return await this.#database.batch(statements);
        } catch (cause) {
            signal.throwIfAborted();
            const conflict = await this.#database
                .prepare(
                    `SELECT grants.grant_id
                       FROM external_identity_bindings AS bindings
                       INNER JOIN external_identity_project_grants AS grants
                         ON grants.binding_id = bindings.binding_id
                      WHERE bindings.provider_id = ? AND bindings.issuer = ? AND bindings.subject = ?
                        AND grants.tenant_id = ? AND grants.project_id = ? AND grants.revoked_at IS NULL`,
                )
                .bind(identity.providerId, identity.issuer, identity.subject, this.#tenantId, scope.projectId)
                .first<{ readonly grant_id: string }>();
            signal.throwIfAborted();
            if (conflict !== null) {
                throw new ProjectAuthenticationError(
                    "external_identity_binding_conflict",
                    "The external identity is already attached to this Project",
                    { cause },
                );
            }
            throw new ProjectAuthenticationError(
                "project_authentication_unavailable",
                "The external identity binding could not be stored",
                { cause },
            );
        }
    };

    readonly listExternalIdentityBindings = async (
        access: ProjectAccessContext,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(
                `SELECT bindings.binding_id, bindings.provider_id, bindings.issuer,
                        bindings.subject, bindings.created_at, bindings.last_verified_at,
                        grants.grant_id, grants.tenant_id, grants.project_id, grants.permissions_json
                   FROM external_identity_project_grants AS grants
                   INNER JOIN external_identity_bindings AS bindings
                     ON bindings.binding_id = grants.binding_id
                  WHERE grants.tenant_id = ? AND grants.project_id = ? AND grants.revoked_at IS NULL
                  ORDER BY grants.created_at DESC, grants.grant_id DESC`,
            )
            .bind(this.#tenantId, access.scope.projectId)
            .all<ExternalBindingRow>();
        signal.throwIfAborted();
        return { bindings: rows.results.map(externalBindingResource) };
    };

    readonly revokeExternalIdentityBinding = async (
        access: ProjectAccessContext,
        bindingId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedBindingId = validateIdentifier(bindingId, "binding_id");
        const now = Date.now();
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE external_identity_project_grants
                        SET revoked_at = COALESCE(revoked_at, ?)
                      WHERE binding_id = ? AND tenant_id = ? AND project_id = ?
                        AND revoked_at IS NULL`,
                )
                .bind(now, normalizedBindingId, this.#tenantId, access.scope.projectId),
            this.#database
                .prepare(
                    `UPDATE mobius_access_credentials SET revoked_at = COALESCE(revoked_at, ?)
                      WHERE grant_id IN (
                        SELECT grant_id FROM external_identity_project_grants
                         WHERE binding_id = ? AND tenant_id = ? AND project_id = ?
                      ) AND revoked_at IS NULL`,
                )
                .bind(now, normalizedBindingId, this.#tenantId, access.scope.projectId),
            this.#database
                .prepare(
                    `INSERT INTO authentication_audit_events (
                       audit_id, tenant_id, project_id, actor_kind, actor_id, actor_ref,
                       action, subject_id, outcome, details_json, recorded_at
                     )
                     SELECT ?, ?, ?, ?, ?, '', ?, ?, 'succeeded', '{}', ?
                     WHERE EXISTS (
                       SELECT 1 FROM external_identity_project_grants
                        WHERE binding_id = ? AND tenant_id = ? AND project_id = ?
                     )`,
                )
                .bind(
                    `aae_${createRandomToken(18)}`,
                    this.#tenantId,
                    access.scope.projectId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "external-identity-binding.revoked",
                    normalizedBindingId,
                    now,
                    normalizedBindingId,
                    this.#tenantId,
                    access.scope.projectId,
                ),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
            throw new ProjectAuthenticationError(
                "external_identity_binding_not_found",
                "The external identity binding was not found",
            );
        }
        return { bindingId: normalizedBindingId, revokedAt: iso(now) };
    };

    readonly listOwnerCredentials = async (access: ProjectAccessContext, signal: AbortSignal): Promise<object> => {
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(
                `SELECT credential_id, source_channel_id, created_at, last_used_at,
                        replaced_by_credential_id, overlap_ends_at, revoked_at
                   FROM project_owner_credentials
                  WHERE project_id = ?
                  ORDER BY created_at DESC, credential_id DESC`,
            )
            .bind(access.scope.projectId)
            .all<OwnerCredentialRow>();
        signal.throwIfAborted();
        return {
            credentials: rows.results.map((row) => ({
                createdAt: iso(row.created_at),
                credentialId: row.credential_id,
                lastUsedAt: iso(row.last_used_at),
                ...credentialLifecycleResource(row.replaced_by_credential_id, row.overlap_ends_at, row.revoked_at),
            })),
            recoveryWarning:
                "Loss of the last active accountless owner credential is not recoverable through an account provider unless an external identity was already attached.",
        };
    };

    readonly rotateOwnerCredential = async (
        access: ProjectAccessContext,
        credentialId: string,
        overlapMilliseconds: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (
            !Number.isSafeInteger(overlapMilliseconds) ||
            overlapMilliseconds < 0 ||
            overlapMilliseconds > CREDENTIAL_OVERLAP_MAXIMUM_MILLISECONDS
        ) {
            throw new ProjectAuthenticationError(
                "credential_overlap_invalid",
                "The credential overlap period is invalid",
            );
        }
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const source = await this.#database
            .prepare(
                `SELECT credential_id, source_channel_id, created_at, last_used_at,
                        replaced_by_credential_id, overlap_ends_at, revoked_at
                   FROM project_owner_credentials
                  WHERE credential_id = ? AND project_id = ?
                    AND revoked_at IS NULL AND replaced_by_credential_id IS NULL`,
            )
            .bind(normalizedCredentialId, access.scope.projectId)
            .first<OwnerCredentialRow>();
        signal.throwIfAborted();
        if (source === null) {
            throw new ProjectAuthenticationError(
                "owner_credential_not_found",
                "The accountless owner credential was not found",
            );
        }
        const now = Date.now();
        const overlapEndsAt = now + overlapMilliseconds;
        const replacementId = `hcr_${createRandomToken(18)}`;
        const replacement = createRandomToken(32);
        const digest = await hashSecret(replacement);
        signal.throwIfAborted();
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO project_owner_credentials (
                       credential_id, project_id, token_hash, source_channel_id,
                       created_at, last_used_at
                     )
                     SELECT ?, ?, ?, source.source_channel_id, ?, ?
                     FROM project_owner_credentials AS source
                     WHERE source.credential_id = ?
                       AND source.project_id = ?
                       AND source.revoked_at IS NULL AND source.replaced_by_credential_id IS NULL`,
                )
                .bind(
                    replacementId,
                    access.scope.projectId,
                    digest,
                    now,
                    now,
                    normalizedCredentialId,
                    access.scope.projectId,
                ),
            this.#database
                .prepare(
                    `INSERT INTO channel_host_credentials (
                       credential_id, channel_id, token_hash, authority, created_at, last_used_at
                     )
                     SELECT ?, source_channel_id, token_hash, 'owner', ?, ?
                     FROM project_owner_credentials AS replacement
                     WHERE replacement.credential_id = ?
                       AND EXISTS (
                         SELECT 1 FROM channel_host_credentials AS source
                          WHERE source.credential_id = ?
                            AND source.channel_id = replacement.source_channel_id
                            AND source.revoked_at IS NULL
                            AND source.replaced_by_credential_id IS NULL
                       )`,
                )
                .bind(replacementId, now, now, replacementId, normalizedCredentialId),
            this.#database
                .prepare(
                    `UPDATE project_owner_credentials
                        SET replaced_by_credential_id = ?, overlap_ends_at = ?
                      WHERE credential_id = ? AND replaced_by_credential_id IS NULL AND revoked_at IS NULL
                        AND EXISTS (
                          SELECT 1 FROM project_owner_credentials AS replacement
                           WHERE replacement.credential_id = ?
                        )`,
                )
                .bind(replacementId, overlapEndsAt, normalizedCredentialId, replacementId),
            this.#database
                .prepare(
                    `UPDATE channel_host_credentials
                        SET replaced_by_credential_id = ?, overlap_ends_at = ?
                      WHERE credential_id = ? AND replaced_by_credential_id IS NULL AND revoked_at IS NULL
                        AND EXISTS (
                          SELECT 1 FROM channel_host_credentials AS replacement
                           WHERE replacement.credential_id = ?
                        )`,
                )
                .bind(replacementId, overlapEndsAt, normalizedCredentialId, replacementId),
            this.#database
                .prepare(
                    `INSERT INTO authentication_audit_events (
                       audit_id, tenant_id, project_id, actor_kind, actor_id, actor_ref,
                       action, subject_id, outcome, details_json, recorded_at
                     )
                     SELECT ?, ?, ?, ?, ?, '', ?, ?, 'succeeded', ?, ?
                     WHERE EXISTS (
                       SELECT 1 FROM project_owner_credentials WHERE credential_id = ?
                     )`,
                )
                .bind(
                    `aae_${createRandomToken(18)}`,
                    this.#tenantId,
                    access.scope.projectId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "owner-credential.rotated",
                    normalizedCredentialId,
                    JSON.stringify({ overlapEndsAt: iso(overlapEndsAt), replacementCredentialId: replacementId }),
                    now,
                    replacementId,
                ),
        ]);
        signal.throwIfAborted();
        if (
            results[0]?.meta.changes !== 1 ||
            results[2]?.meta.changes !== 1 ||
            results[4]?.meta.changes !== 1 ||
            results[1]?.meta.changes !== results[3]?.meta.changes
        ) {
            throw new ProjectAuthenticationError(
                "owner_credential_rotation_conflict",
                "The accountless owner credential could not be rotated",
            );
        }
        return {
            credential: replacement,
            credentialId: replacementId,
            issuedAt: iso(now),
            overlapEndsAt: iso(overlapEndsAt),
            replacedCredentialId: normalizedCredentialId,
        };
    };

    readonly revokeOwnerCredential = async (
        access: ProjectAccessContext,
        credentialId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedCredentialId = validateIdentifier(credentialId, "credential_id");
        const now = Date.now();
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `UPDATE project_owner_credentials SET revoked_at = COALESCE(revoked_at, ?)
                      WHERE credential_id = ? AND project_id = ?`,
                )
                .bind(now, normalizedCredentialId, access.scope.projectId),
            this.#database
                .prepare(
                    `UPDATE channel_host_credentials SET revoked_at = COALESCE(revoked_at, ?)
                      WHERE credential_id = ? AND channel_id IN (
                        SELECT source_channel_id FROM project_owner_credentials
                         WHERE credential_id = ? AND project_id = ?
                      )`,
                )
                .bind(now, normalizedCredentialId, normalizedCredentialId, access.scope.projectId),
            this.#database
                .prepare(
                    `INSERT INTO authentication_audit_events (
                       audit_id, tenant_id, project_id, actor_kind, actor_id, actor_ref,
                       action, subject_id, outcome, details_json, recorded_at
                     )
                     SELECT ?, ?, ?, ?, ?, '', ?, ?, 'succeeded', '{}', ?
                     WHERE EXISTS (
                       SELECT 1 FROM project_owner_credentials
                        WHERE credential_id = ? AND project_id = ?
                     )`,
                )
                .bind(
                    `aae_${createRandomToken(18)}`,
                    this.#tenantId,
                    access.scope.projectId,
                    access.actor.kind.value,
                    access.actor.actorId,
                    "owner-credential.revoked",
                    normalizedCredentialId,
                    now,
                    normalizedCredentialId,
                    access.scope.projectId,
                ),
        ]);
        signal.throwIfAborted();
        if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
            throw new ProjectAuthenticationError(
                "owner_credential_not_found",
                "The accountless owner credential was not found",
            );
        }
        return {
            credentialId: normalizedCredentialId,
            recoveryWarning:
                "Loss of the last active accountless owner credential is not recoverable through an account provider unless an external identity was already attached.",
            revokedAt: iso(now),
        };
    };

    readonly listAuditEvents = async (
        access: ProjectAccessContext,
        limit: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_AUDIT_PAGE_SIZE) {
            throw new ProjectAuthenticationError("audit_page_invalid", "The authentication audit page is invalid");
        }
        const rows = await this.#database
            .prepare(
                `SELECT audit_id, actor_kind, actor_id, actor_ref, action, subject_id,
                        outcome, details_json, recorded_at
                   FROM authentication_audit_events
                  WHERE tenant_id = ? AND project_id = ?
                  ORDER BY recorded_at DESC, audit_id DESC LIMIT ?`,
            )
            .bind(this.#tenantId, access.scope.projectId, limit)
            .all<Readonly<Record<string, unknown>>>();
        signal.throwIfAborted();
        return {
            events: rows.results.map((row) => ({
                action: row["action"],
                actorId: row["actor_id"],
                actorKind: row["actor_kind"],
                actorRef: row["actor_ref"],
                auditId: row["audit_id"],
                details: this.auditDetails(row["details_json"]),
                outcome: row["outcome"],
                recordedAt: typeof row["recorded_at"] === "number" ? iso(row["recorded_at"]) : "",
                subjectId: row["subject_id"],
            })),
        };
    };

    private readonly authenticateCapabilityCredential = async (
        credential: ProjectCredential,
        requiredPermission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const now = Date.now();
        const digest = await hashSecret(credential.value);
        signal.throwIfAborted();
        const rows = await this.#database
            .prepare(
                `SELECT 'owner' AS source, credential_id, project_id,
                        'accountless_owner' AS actor_kind, credential_id AS actor_id,
                        NULL AS expires_at, revoked_at, replaced_by_credential_id,
                        overlap_ends_at, 'active' AS source_status
                   FROM project_owner_credentials
                  WHERE token_hash = ?
                 UNION ALL
                 SELECT 'linked' AS source, credentials.credential_id,
                        channels.project_id,
                        'browser_access' AS actor_kind,
                        credentials.credential_id AS actor_id, NULL AS expires_at,
                        credentials.revoked_at, credentials.replaced_by_credential_id,
                        credentials.overlap_ends_at, channels.status AS source_status
                   FROM channel_host_credentials AS credentials
                   INNER JOIN pairing_channels AS channels ON channels.channel_id = credentials.channel_id
                  WHERE credentials.token_hash = ? AND credentials.authority = 'linked'
                 UNION ALL
                 SELECT 'browser' AS source, credential_id, project_id,
                        'browser_access' AS actor_kind, credential_id AS actor_id, expires_at,
                        revoked_at, NULL AS replaced_by_credential_id,
                        NULL AS overlap_ends_at, 'active' AS source_status
                   FROM project_browser_credentials
                  WHERE token_hash = ?`,
            )
            .bind(digest, digest, digest)
            .all<CapabilityCredentialRow>();
        signal.throwIfAborted();
        const row = rows.results[0];
        if (rows.results.length !== 1 || row === undefined) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
        }
        if (
            typeof row.revoked_at === "number" ||
            (row.source_status !== "active" && row.source_status !== "paired") ||
            (typeof row.replaced_by_credential_id === "string" &&
                (typeof row.overlap_ends_at !== "number" || row.overlap_ends_at <= now))
        ) {
            throw new ProjectAuthenticationError("credential_revoked", "The Project credential was revoked");
        }
        if (typeof row.expires_at === "number" && row.expires_at <= now) {
            throw new ProjectAuthenticationError("credential_expired", "The Project credential expired");
        }
        const kind = actorKind(row.actor_kind);
        const lifetime =
            typeof row.expires_at === "number"
                ? new ExpiringProjectAccessLifetime(row.expires_at)
                : new PerpetualProjectAccessLifetime();
        const access = new ProjectAccessContext(
            new ProjectScope(row.project_id),
            new Set(row.source === "owner" ? PROJECT_PERMISSIONS : INTERACTIVE_PROJECT_PERMISSIONS),
            new AuditActor(kind, row.actor_id),
            row.credential_id,
            now,
            lifetime,
        );
        return await this.touchAndAuthorize(access, row.source, requiredPermission, actorReference, now, signal);
    };

    private readonly authenticateApplicationCredential = async (
        credential: ProjectCredential,
        requiredPermission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const now = Date.now();
        const row = await this.#database
            .prepare(
                `SELECT credentials.credential_id, credentials.expires_at,
                        credentials.revoked_at, credentials.replaced_by_credential_id,
                        credentials.overlap_ends_at, applications.lifecycle,
                        applications.application_id, applications.tenant_id,
                        applications.project_id, applications.permissions_json
                   FROM project_application_credentials AS credentials
                   INNER JOIN project_applications AS applications
                     ON applications.application_id = credentials.application_id
                  WHERE credentials.public_credential_id = ? AND credentials.secret_digest = ?
                    `,
            )
            .bind(credential.publicCredentialId, await hashSecret(credential.value))
            .first<ApplicationCredentialRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new ProjectAuthenticationError(
                "project_credential_invalid",
                "The Project application credential is invalid",
            );
        }
        if (
            typeof row.revoked_at === "number" ||
            row.lifecycle !== "active" ||
            (typeof row.replaced_by_credential_id === "string" &&
                (typeof row.overlap_ends_at !== "number" || row.overlap_ends_at <= now))
        ) {
            throw new ProjectAuthenticationError(
                "credential_revoked",
                "The Project application credential was revoked",
            );
        }
        if (row.expires_at <= now) {
            throw new ProjectAuthenticationError("credential_expired", "The Project application credential expired");
        }
        const access = new ProjectAccessContext(
            new ProjectScope(row.project_id),
            permissionsFromRow(row.permissions_json),
            new AuditActor(AuditActorKind.Application, row.application_id),
            row.credential_id,
            now,
            new ExpiringProjectAccessLifetime(row.expires_at),
        );
        return await this.touchAndAuthorize(access, "application", requiredPermission, actorReference, now, signal);
    };

    private readonly authenticateAccessCredential = async (
        credential: ProjectCredential,
        requiredPermission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        const now = Date.now();
        const row = await this.#database
            .prepare(
                `SELECT credentials.credential_id, credentials.grant_id,
                        credentials.tenant_id, credentials.project_id,
                        credentials.permissions_json, credentials.expires_at,
                        credentials.revoked_at, grants.revoked_at AS grant_revoked_at
                   FROM mobius_access_credentials AS credentials
                   INNER JOIN external_identity_project_grants AS grants
                     ON grants.grant_id = credentials.grant_id
                  WHERE credentials.public_credential_id = ? AND credentials.secret_digest = ?`,
            )
            .bind(credential.publicCredentialId, await hashSecret(credential.value))
            .first<AccessCredentialRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new ProjectAuthenticationError(
                "project_credential_invalid",
                "The Mobius access credential is invalid",
            );
        }
        if (typeof row.revoked_at === "number" || typeof row.grant_revoked_at === "number") {
            throw new ProjectAuthenticationError("credential_revoked", "The Mobius access credential was revoked");
        }
        if (row.expires_at <= now) {
            throw new ProjectAuthenticationError("credential_expired", "The Mobius access credential expired");
        }
        const access = new ProjectAccessContext(
            new ProjectScope(row.project_id),
            permissionsFromRow(row.permissions_json),
            new AuditActor(AuditActorKind.ExternalIdentity, row.grant_id),
            row.credential_id,
            now,
            new ExpiringProjectAccessLifetime(row.expires_at),
        );
        return await this.touchAndAuthorize(access, "access", requiredPermission, actorReference, now, signal);
    };

    private readonly touchAndAuthorize = async (
        access: ProjectAccessContext,
        source: string,
        requiredPermission: ProjectPermission,
        actorReference: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> => {
        if (!access.permits(requiredPermission)) {
            await this.recordAudit(
                access.scope,
                access.actor,
                actorReference,
                "project.authorization",
                access.credentialId,
                "denied",
                { permission: requiredPermission.value },
                now,
                signal,
            );
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The Project credential does not grant this operation",
            );
        }
        const touch = this.touchStatement(source, access.credentialId, now);
        const results = await this.#database.batch([
            touch,
            this.auditStatement(
                access.scope,
                access.actor,
                actorReference,
                "project.authorization",
                access.credentialId,
                "succeeded",
                { permission: requiredPermission.value },
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new ProjectAuthenticationError(
                "project_credential_invalid",
                "The Project credential is no longer valid",
            );
        }
        return access;
    };

    private readonly touchStatement = (source: string, credentialId: string, now: number): D1PreparedStatement => {
        if (source === "owner") {
            return this.#database
                .prepare(
                    `UPDATE project_owner_credentials SET last_used_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL
                        AND (replaced_by_credential_id IS NULL OR overlap_ends_at > ?)`,
                )
                .bind(now, credentialId, now);
        }
        if (source === "linked") {
            return this.#database
                .prepare(
                    `UPDATE channel_host_credentials SET last_used_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL
                        AND (replaced_by_credential_id IS NULL OR overlap_ends_at > ?)`,
                )
                .bind(now, credentialId, now);
        }
        if (source === "browser") {
            return this.#database
                .prepare(
                    `UPDATE project_browser_credentials SET last_used_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?`,
                )
                .bind(now, credentialId, now);
        }
        if (source === "application") {
            return this.#database
                .prepare(
                    `UPDATE project_application_credentials SET last_used_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?
                        AND (replaced_by_credential_id IS NULL OR overlap_ends_at > ?)`,
                )
                .bind(now, credentialId, now, now);
        }
        if (source === "access") {
            return this.#database
                .prepare(
                    `UPDATE mobius_access_credentials SET last_used_at = ?
                      WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?`,
                )
                .bind(now, credentialId, now);
        }
        throw new ProjectAuthenticationError(
            "project_authorization_record_invalid",
            "The stored Project authorization is invalid",
        );
    };

    private readonly readActiveApplication = async (
        scope: ProjectScope,
        applicationId: string,
        signal: AbortSignal,
    ): Promise<ApplicationRow> => {
        const row = await this.#database
            .prepare(
                `SELECT * FROM project_applications
                  WHERE application_id = ? AND tenant_id = ? AND project_id = ? AND lifecycle = 'active'`,
            )
            .bind(validateIdentifier(applicationId, "application_id"), this.#tenantId, scope.projectId)
            .first<ApplicationRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new ProjectAuthenticationError(
                "project_application_not_found",
                "The Project application was not found",
            );
        }
        return row;
    };

    private readonly insertApplicationCredential = async (
        access: ProjectAccessContext,
        application: ApplicationRow,
        lifetimeMilliseconds: number,
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        const created = await this.createApplicationCredential(application, lifetimeMilliseconds, now);
        const results = await this.#database.batch([
            this.#database
                .prepare(
                    `INSERT INTO project_application_credentials (
                       credential_id, public_credential_id, application_id, secret_digest,
                       issued_at, expires_at, last_used_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    created.credentialId,
                    created.publicCredentialId,
                    application.application_id,
                    created.digest,
                    now,
                    created.expiresAt,
                    now,
                ),
            this.auditStatement(
                access.scope,
                access.actor,
                "",
                "project-application-credential.issued",
                created.credentialId,
                "succeeded",
                { applicationId: application.application_id, expiresAt: iso(now + lifetimeMilliseconds) },
                now,
            ),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new ProjectAuthenticationError(
                "project_authentication_unavailable",
                "The Project application credential could not be issued",
            );
        }
        return created.resource;
    };

    private readonly createApplicationCredential = async (
        application: ApplicationRow,
        lifetimeMilliseconds: number,
        now: number,
    ) => {
        const publicCredentialId = createRandomToken(16);
        const credentialId = `pac_${publicCredentialId}`;
        const credential = `mapp_${publicCredentialId}_${createRandomToken(32)}`;
        const expiresAt = now + lifetimeMilliseconds;
        return {
            credentialId,
            digest: await hashSecret(credential),
            expiresAt,
            publicCredentialId,
            resource: {
                applicationId: application.application_id,
                credential,
                credentialId,
                expiresAt: iso(expiresAt),
                issuedAt: iso(now),
                publicCredentialId,
            },
        };
    };

    private readonly validateApplicationCredentialLifetime = (lifetimeMilliseconds: number): void => {
        if (
            !Number.isSafeInteger(lifetimeMilliseconds) ||
            lifetimeMilliseconds < APPLICATION_CREDENTIAL_MINIMUM_LIFETIME_MILLISECONDS ||
            lifetimeMilliseconds > APPLICATION_CREDENTIAL_MAXIMUM_LIFETIME_MILLISECONDS
        ) {
            throw new ProjectAuthenticationError(
                "application_credential_lifetime_invalid",
                "The Project application credential lifetime is invalid",
            );
        }
    };

    private readonly auditStatement = (
        scope: ProjectScope,
        actor: AuditActor,
        actorReference: string,
        action: string,
        subjectId: string,
        outcome: string,
        details: Readonly<Record<string, unknown>>,
        now: number,
    ): D1PreparedStatement =>
        this.#database
            .prepare(
                `INSERT INTO authentication_audit_events (
                   audit_id, tenant_id, project_id, actor_kind, actor_id, actor_ref,
                   action, subject_id, outcome, details_json, recorded_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                `aae_${createRandomToken(18)}`,
                this.#tenantId,
                scope.projectId,
                actor.kind.value,
                actor.actorId,
                sanitizedActorReference(actorReference),
                action,
                subjectId,
                outcome,
                JSON.stringify(details),
                now,
            );

    private readonly recordAudit = async (
        scope: ProjectScope,
        actor: AuditActor,
        actorReference: string,
        action: string,
        subjectId: string,
        outcome: string,
        details: Readonly<Record<string, unknown>>,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const recorded = await this.auditStatement(
            scope,
            actor,
            actorReference,
            action,
            subjectId,
            outcome,
            details,
            now,
        ).run();
        signal.throwIfAborted();
        if (recorded.meta.changes !== 1) {
            throw new ProjectAuthenticationError(
                "project_authentication_unavailable",
                "The Project authentication audit event could not be recorded",
            );
        }
    };

    private readonly auditDetails = (value: unknown): Readonly<Record<string, unknown>> => {
        if (typeof value !== "string") {
            throw new ProjectAuthenticationError(
                "project_authorization_record_invalid",
                "The stored Project authorization audit record is invalid",
            );
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(value);
        } catch (cause) {
            throw new ProjectAuthenticationError(
                "project_authorization_record_invalid",
                "The stored Project authorization audit record is invalid",
                { cause },
            );
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new ProjectAuthenticationError(
                "project_authorization_record_invalid",
                "The stored Project authorization audit record is invalid",
            );
        }
        return Object.freeze(Object.fromEntries(Object.entries(parsed)));
    };
}
