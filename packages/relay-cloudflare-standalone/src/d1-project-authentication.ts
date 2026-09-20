import {
    AuditActor,
    AuditActorKind,
    createRandomToken,
    D1DatabaseAdapter,
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
import { relayDrizzle, type SqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import {
    authenticationAuditEvent,
    channelHostCredential,
    pairingChannel,
    projectBrowserCredential,
    projectOwnerCredential,
} from "@moxt-ai/mobius-relay-core/schema";
import { and, eq, gt, isNull, or } from "drizzle-orm";

interface CapabilityCredentialRow {
    readonly credential_id: string;
    readonly expires_at: number | null;
    readonly overlap_ends_at: number | null;
    readonly project_id: string;
    readonly replaced_by_credential_id: string | null;
    readonly revoked_at: number | null;
    readonly source: "browser" | "linked" | "owner";
    readonly source_status: string;
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

function storedActorKind(actor: AuditActor): "accountless_owner" | "browser_access" {
    if (actor.kind === AuditActorKind.AccountlessOwner) {
        return "accountless_owner";
    }
    if (actor.kind === AuditActorKind.BrowserAccess) {
        return "browser_access";
    }
    throw new ProjectAuthenticationError(
        "project_authorization_record_invalid",
        "The Project authorization actor is invalid",
    );
}

export class D1ProjectAuthentication implements ProjectAccessAuthorizer {
    readonly #database: SqlDatabase;

    constructor(database: D1Database) {
        this.#database = D1DatabaseAdapter.from(database);
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
        const database = relayDrizzle(this.#database, signal);
        const [owners, linkedCredentials, browserCredentials] = await Promise.all([
            database
                .select({
                    credential_id: projectOwnerCredential.credentialId,
                    project_id: projectOwnerCredential.projectId,
                    revoked_at: projectOwnerCredential.revokedAt,
                    replaced_by_credential_id: projectOwnerCredential.replacedByCredentialId,
                    overlap_ends_at: projectOwnerCredential.overlapEndsAt,
                })
                .from(projectOwnerCredential)
                .where(eq(projectOwnerCredential.tokenHash, digest)),
            database
                .select({
                    credential_id: channelHostCredential.credentialId,
                    project_id: pairingChannel.projectId,
                    revoked_at: channelHostCredential.revokedAt,
                    replaced_by_credential_id: channelHostCredential.replacedByCredentialId,
                    overlap_ends_at: channelHostCredential.overlapEndsAt,
                    source_status: pairingChannel.status,
                })
                .from(channelHostCredential)
                .innerJoin(pairingChannel, eq(pairingChannel.channelId, channelHostCredential.channelId))
                .where(and(eq(channelHostCredential.tokenHash, digest), eq(channelHostCredential.authority, "linked"))),
            database
                .select({
                    credential_id: projectBrowserCredential.credentialId,
                    project_id: projectBrowserCredential.projectId,
                    expires_at: projectBrowserCredential.expiresAt,
                    revoked_at: projectBrowserCredential.revokedAt,
                })
                .from(projectBrowserCredential)
                .where(eq(projectBrowserCredential.tokenHash, digest)),
        ]);
        signal.throwIfAborted();
        const rows: readonly CapabilityCredentialRow[] = [
            ...owners.map((row) => ({ ...row, expires_at: null, source: "owner" as const, source_status: "active" })),
            ...linkedCredentials.map((row) => ({ ...row, expires_at: null, source: "linked" as const })),
            ...browserCredentials.map((row) => ({
                ...row,
                overlap_ends_at: null,
                replaced_by_credential_id: null,
                source: "browser" as const,
                source_status: "active",
            })),
        ];
        const row = rows[0];
        if (rows.length !== 1 || row === undefined) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Project credential is invalid");
        }
        if (
            row.revoked_at !== null ||
            (row.source_status !== "active" && row.source_status !== "paired") ||
            (row.replaced_by_credential_id !== null && (row.overlap_ends_at === null || row.overlap_ends_at <= now))
        ) {
            throw new ProjectAuthenticationError("credential_revoked", "The Project credential was revoked");
        }
        if (row.expires_at !== null && row.expires_at <= now) {
            throw new ProjectAuthenticationError("credential_expired", "The Project credential expired");
        }
        const kind = row.source === "owner" ? AuditActorKind.AccountlessOwner : AuditActorKind.BrowserAccess;
        const lifetime =
            row.expires_at === null
                ? new PerpetualProjectAccessLifetime()
                : new ExpiringProjectAccessLifetime(row.expires_at);
        const access = new ProjectAccessContext(
            new ProjectScope(row.project_id),
            new Set(row.source === "owner" ? PROJECT_PERMISSIONS : INTERACTIVE_PROJECT_PERMISSIONS),
            new AuditActor(kind, row.credential_id),
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
        const database = relayDrizzle(this.#database, signal);
        const activeReplacement = or(
            isNull(projectOwnerCredential.replacedByCredentialId),
            gt(projectOwnerCredential.overlapEndsAt, now),
        );
        const audit = database
            .insert(authenticationAuditEvent)
            .values(
                this.auditValues(
                    access.scope,
                    access.actor,
                    actorReference,
                    "project.authorization",
                    access.credentialId,
                    "succeeded",
                    { permission: requiredPermission.value },
                    now,
                ),
            )
            .returning({ auditId: authenticationAuditEvent.auditId });
        const results =
            source === "owner"
                ? await database.batch([
                      database
                          .update(projectOwnerCredential)
                          .set({ lastUsedAt: now })
                          .where(
                              and(
                                  eq(projectOwnerCredential.credentialId, access.credentialId),
                                  isNull(projectOwnerCredential.revokedAt),
                                  activeReplacement,
                              ),
                          )
                          .returning({ credentialId: projectOwnerCredential.credentialId }),
                      audit,
                  ])
                : source === "linked"
                  ? await database.batch([
                        database
                            .update(channelHostCredential)
                            .set({ lastUsedAt: now })
                            .where(
                                and(
                                    eq(channelHostCredential.credentialId, access.credentialId),
                                    isNull(channelHostCredential.revokedAt),
                                    or(
                                        isNull(channelHostCredential.replacedByCredentialId),
                                        gt(channelHostCredential.overlapEndsAt, now),
                                    ),
                                ),
                            )
                            .returning({ credentialId: channelHostCredential.credentialId }),
                        audit,
                    ])
                  : source === "browser"
                    ? await database.batch([
                          database
                              .update(projectBrowserCredential)
                              .set({ lastUsedAt: now })
                              .where(
                                  and(
                                      eq(projectBrowserCredential.credentialId, access.credentialId),
                                      isNull(projectBrowserCredential.revokedAt),
                                      gt(projectBrowserCredential.expiresAt, now),
                                  ),
                              )
                              .returning({ credentialId: projectBrowserCredential.credentialId }),
                          audit,
                      ])
                    : undefined;
        signal.throwIfAborted();
        if (results === undefined || results.some((result) => result.length !== 1)) {
            throw new ProjectAuthenticationError(
                "project_credential_invalid",
                "The Project credential is no longer valid",
            );
        }
        return access;
    };

    private readonly auditValues = (
        scope: ProjectScope,
        actor: AuditActor,
        actorReference: string,
        action: string,
        subjectId: string,
        outcome: "denied" | "succeeded",
        details: Readonly<Record<string, unknown>>,
        now: number,
    ) => ({
        auditId: `aae_${createRandomToken(18)}`,
        projectId: scope.projectId,
        actorKind: storedActorKind(actor),
        actorId: actor.actorId,
        actorRef: sanitizedActorReference(actorReference),
        action,
        subjectId,
        outcome,
        detailsJson: JSON.stringify(details),
        recordedAt: now,
    });

    private readonly recordAudit = async (
        scope: ProjectScope,
        actor: AuditActor,
        actorReference: string,
        action: string,
        subjectId: string,
        outcome: "denied" | "succeeded",
        details: Readonly<Record<string, unknown>>,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const recorded = await relayDrizzle(this.#database, signal)
            .insert(authenticationAuditEvent)
            .values(this.auditValues(scope, actor, actorReference, action, subjectId, outcome, details, now))
            .returning({ auditId: authenticationAuditEvent.auditId });
        signal.throwIfAborted();
        if (recorded.length !== 1) {
            throw new ProjectAuthenticationError(
                "project_authentication_unavailable",
                "The Project authentication audit event could not be recorded",
            );
        }
    };
}
