import {
    AuditActor,
    AuditActorKind,
    createRandomToken,
    decodeProjectCredential,
    ExpiringProjectAccessLifetime,
    hashSecret,
    INTERACTIVE_PROJECT_PERMISSIONS,
    PerpetualProjectAccessLifetime,
    PROJECT_PERMISSIONS,
    type ProjectAccessAuthorizer,
    ProjectAccessContext,
    ProjectAuthenticationError,
    type ProjectCredential,
    type ProjectPermission,
    ProjectScope,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";

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

function actorKind(value: string): AuditActorKind {
    if (value === AuditActorKind.AccountlessOwner.value) {
        return AuditActorKind.AccountlessOwner;
    }
    if (value === AuditActorKind.BrowserAccess.value) {
        return AuditActorKind.BrowserAccess;
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

export class D1ProjectAuthentication implements ProjectAccessAuthorizer {
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
        return await this.authenticateCapabilityCredential(credential, requiredPermission, actorReference, signal);
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
        throw new ProjectAuthenticationError(
            "project_authorization_record_invalid",
            "The stored Project authorization is invalid",
        );
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
}
