import { and, count, eq, exists, gt, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";
import { MAX_RUNTIMES_PER_PROJECT } from "../entity/pairing/pairing.ts";
import type {
    PairingChannelRow,
    PairingClaimRow,
    RuntimeDirectoryRow,
    RuntimePairingAudit,
    RuntimePairingRow,
} from "../entity/pairing/pairing-records.ts";
import { type RelayDrizzleDatabase, relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import {
    channelAccessGrant,
    channelHostCredential,
    runtimeDaemonCredential,
    runtimeIdentity,
    runtimePairingAuditEvent,
    runtimePairingRequest,
    runtimeRegistration,
} from "../schema/project-do/index.ts";

const identityFields = {
    channel_id: runtimeIdentity.channelId,
    runtime_id: runtimeIdentity.runtimeId,
    project_id: runtimeIdentity.projectId,
};
const registrationFields = {
    claimed_at: runtimeRegistration.claimedAt,
    agents_json: runtimeRegistration.agentsJson,
    machine_name: runtimeRegistration.machineName,
    workspace_name: runtimeRegistration.workspaceName,
};

interface CreateRuntimePairing {
    readonly pairingId: string;
    readonly codeHash: string;
    readonly pollHash: string;
    readonly channelId: string;
    readonly runtimeId: string;
    readonly now: number;
    readonly expiresAt: number;
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly auditId: string;
}

function occupiedRuntimeCount(database: RelayDrizzleDatabase, projectId: string, now: number) {
    return database
        .select({ count: count() })
        .from(runtimeIdentity)
        .where(
            and(
                eq(runtimeIdentity.projectId, projectId),
                isNull(runtimeIdentity.revokedAt),
                or(
                    exists(
                        database
                            .select({ runtimeId: runtimeRegistration.runtimeId })
                            .from(runtimeRegistration)
                            .where(eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId)),
                    ),
                    exists(
                        database
                            .select({ runtimeId: runtimePairingRequest.runtimeId })
                            .from(runtimePairingRequest)
                            .where(
                                and(
                                    eq(runtimePairingRequest.runtimeId, runtimeIdentity.runtimeId),
                                    gt(runtimePairingRequest.expiresAt, now),
                                ),
                            ),
                    ),
                ),
            ),
        );
}

// This is the sole writer of Runtime identities, pairing requests,
// registrations, and daemon credentials. Every cross-record transition is a
// command whose writes and audit event commit together in one database batch.
export class RuntimeDirectoryStorage {
    readonly #projectId: string;
    readonly #database: SqlDatabase;

    constructor(projectId: string, database: SqlDatabase) {
        this.#projectId = projectId;
        this.#database = database;
    }

    private readonly statement = (query: { readonly toSQL: () => { sql: string; params: unknown[] } }) => {
        const { sql, params } = query.toSQL();
        return this.#database.prepare(sql).bind(...params);
    };

    private readonly pairingQuery = (database: RelayDrizzleDatabase) =>
        database
            .select({
                ...identityFields,
                pairing_id: runtimePairingRequest.pairingId,
                poll_token_hash: runtimePairingRequest.pollTokenHash,
                expires_at: runtimePairingRequest.expiresAt,
                revoked_at: runtimeIdentity.revokedAt,
                registration: registrationFields,
            })
            .from(runtimePairingRequest)
            .innerJoin(runtimeIdentity, eq(runtimeIdentity.runtimeId, runtimePairingRequest.runtimeId))
            .leftJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId));

    readonly readPairingCode = async (codeHash: string, signal: AbortSignal): Promise<PairingClaimRow | null> => {
        const rows = await this.pairingQuery(relayDrizzle(this.#database, signal))
            .where(
                and(
                    eq(runtimeIdentity.projectId, this.#projectId),
                    eq(runtimePairingRequest.pairingCodeHash, codeHash),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readProjectPairing = async (pairingId: string, signal: AbortSignal): Promise<PairingChannelRow | null> => {
        const rows = await this.pairingQuery(relayDrizzle(this.#database, signal))
            .where(and(eq(runtimeIdentity.projectId, this.#projectId), eq(runtimePairingRequest.pairingId, pairingId)))
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readRuntimePairingRequest = async (
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<RuntimePairingRow | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({
                ...identityFields,
                pairing_id: runtimePairingRequest.pairingId,
                pairing_code_hash: runtimePairingRequest.pairingCodeHash,
                poll_token_hash: runtimePairingRequest.pollTokenHash,
                expires_at: runtimePairingRequest.expiresAt,
                created_by_owner_credential_id: runtimePairingRequest.createdByOwnerCredentialId,
            })
            .from(runtimePairingRequest)
            .innerJoin(runtimeIdentity, eq(runtimeIdentity.runtimeId, runtimePairingRequest.runtimeId))
            .where(
                and(
                    eq(runtimeIdentity.projectId, this.#projectId),
                    eq(runtimePairingRequest.creationIdempotencyKey, idempotencyKey),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly createRuntimePairing = async (value: CreateRuntimePairing, signal: AbortSignal): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        // The capacity predicate is part of the INSERT, not an earlier read.
        // SQLite serializes this batch with competing creations, claims, and
        // revocations. Expired requests need no cleanup to stop reserving space.
        const identity = database.insert(runtimeIdentity).select(
            database
                .select({
                    runtimeId: sql<string>`${value.runtimeId}`.as("runtime_id"),
                    channelId: sql<string>`${value.channelId}`.as("channel_id"),
                    projectId: sql<string>`${this.#projectId}`.as("project_id"),
                    createdAt: sql<number>`${value.now}`.as("created_at"),
                    revokedAt: sql<null>`null`.as("revoked_at"),
                    revokedByOwnerCredentialId: sql<null>`null`.as("revoked_by_owner_credential_id"),
                })
                .from(sql`(select 1)`)
                .where(lt(occupiedRuntimeCount(database, this.#projectId, value.now), MAX_RUNTIMES_PER_PROJECT)),
        );
        const request = database.insert(runtimePairingRequest).select(
            database
                .select({
                    pairingId: sql<string>`${value.pairingId}`.as("pairing_id"),
                    runtimeId: runtimeIdentity.runtimeId,
                    pairingCodeHash: sql<string>`${value.codeHash}`.as("pairing_code_hash"),
                    pollTokenHash: sql<string>`${value.pollHash}`.as("poll_token_hash"),
                    expiresAt: sql<number>`${value.expiresAt}`.as("expires_at"),
                    creationIdempotencyKey: sql<string>`${value.idempotencyKey}`.as("creation_idempotency_key"),
                    createdByOwnerCredentialId: sql<string>`${value.ownerId}`.as("created_by_owner_credential_id"),
                })
                .from(runtimeIdentity)
                .where(eq(runtimeIdentity.runtimeId, value.runtimeId)),
        );
        const audit = database.insert(runtimePairingAuditEvent).select(
            database
                .select({
                    auditId: sql<string>`${value.auditId}`.as("audit_id"),
                    projectId: runtimeIdentity.projectId,
                    pairingId: runtimePairingRequest.pairingId,
                    runtimeId: runtimeIdentity.runtimeId,
                    actorKind: sql<string>`${value.actorKind}`.as("actor_kind"),
                    actorId: sql<string>`${value.actorId}`.as("actor_id"),
                    action: sql<"runtime_pairing.requested">`'runtime_pairing.requested'`.as("action"),
                    detailsJson: sql<string>`${JSON.stringify({ idempotencyKey: value.idempotencyKey })}`.as(
                        "details_json",
                    ),
                    recordedAt: runtimeIdentity.createdAt,
                })
                .from(runtimePairingRequest)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.runtimeId, runtimePairingRequest.runtimeId))
                .where(eq(runtimePairingRequest.pairingId, value.pairingId)),
        );
        const results = await this.#database.batch(
            [this.statement(identity), this.statement(request), this.statement(audit)],
            signal,
        );
        return results[0]?.meta.changes === 1;
    };

    readonly claim = async (
        value: {
            readonly pairingId: string;
            readonly codeHash: string;
            readonly daemonHash: string;
            readonly now: number;
            readonly machineName: string;
            readonly workspaceName: string;
            readonly agents: string;
            readonly auditId: string;
        },
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const credential = database.insert(runtimeDaemonCredential).select(
            database
                .select({
                    runtimeId: runtimeIdentity.runtimeId,
                    tokenHash: sql<string>`${value.daemonHash}`.as("token_hash"),
                })
                .from(runtimePairingRequest)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.runtimeId, runtimePairingRequest.runtimeId))
                .where(
                    and(
                        eq(runtimeIdentity.projectId, this.#projectId),
                        eq(runtimePairingRequest.pairingId, value.pairingId),
                        eq(runtimePairingRequest.pairingCodeHash, value.codeHash),
                        gt(runtimePairingRequest.expiresAt, value.now),
                        isNull(runtimeIdentity.revokedAt),
                        // A delayed command can arrive after a newer creation
                        // has reclaimed its expired reservation. Recheck the
                        // same capacity rule inside the claim transaction.
                        lte(occupiedRuntimeCount(database, this.#projectId, value.now), MAX_RUNTIMES_PER_PROJECT),
                        notExists(
                            database
                                .select({ runtimeId: runtimeRegistration.runtimeId })
                                .from(runtimeRegistration)
                                .where(eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId)),
                        ),
                    ),
                ),
        );
        const registration = database.insert(runtimeRegistration).select(
            database
                .select({
                    runtimeId: runtimeDaemonCredential.runtimeId,
                    claimedAt: sql<number>`${value.now}`.as("claimed_at"),
                    machineName: sql<string>`${value.machineName}`.as("machine_name"),
                    workspaceName: sql<string>`${value.workspaceName}`.as("workspace_name"),
                    agentsJson: sql<string>`${value.agents}`.as("agents_json"),
                })
                .from(runtimeDaemonCredential)
                .where(
                    and(
                        eq(runtimeDaemonCredential.tokenHash, value.daemonHash),
                        notExists(
                            database
                                .select({ runtimeId: runtimeRegistration.runtimeId })
                                .from(runtimeRegistration)
                                .where(eq(runtimeRegistration.runtimeId, runtimeDaemonCredential.runtimeId)),
                        ),
                    ),
                ),
        );
        const audit = database.insert(runtimePairingAuditEvent).select(
            database
                .select({
                    auditId: sql<string>`${value.auditId}`.as("audit_id"),
                    projectId: runtimeIdentity.projectId,
                    pairingId: runtimePairingRequest.pairingId,
                    runtimeId: runtimeIdentity.runtimeId,
                    actorKind: sql<string>`'runtime'`.as("actor_kind"),
                    actorId: runtimeIdentity.runtimeId,
                    action: sql<"runtime_pairing.claimed">`'runtime_pairing.claimed'`.as("action"),
                    detailsJson: sql<string>`'{}'`.as("details_json"),
                    recordedAt: runtimeRegistration.claimedAt,
                })
                .from(runtimeDaemonCredential)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.runtimeId, runtimeDaemonCredential.runtimeId))
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
                .innerJoin(runtimePairingRequest, eq(runtimePairingRequest.runtimeId, runtimeIdentity.runtimeId))
                .where(
                    and(
                        eq(runtimeDaemonCredential.tokenHash, value.daemonHash),
                        notExists(
                            database
                                .select({ auditId: runtimePairingAuditEvent.auditId })
                                .from(runtimePairingAuditEvent)
                                .where(
                                    and(
                                        eq(runtimePairingAuditEvent.pairingId, value.pairingId),
                                        eq(runtimePairingAuditEvent.action, "runtime_pairing.claimed"),
                                    ),
                                ),
                        ),
                    ),
                ),
        );
        const results = await this.#database.batch(
            [this.statement(credential), this.statement(registration), this.statement(audit)],
            signal,
        );
        return results[0]?.meta.changes === 1;
    };

    readonly recordAudit = async (value: RuntimePairingAudit, signal: AbortSignal): Promise<void> => {
        await relayDrizzle(this.#database, signal)
            .insert(runtimePairingAuditEvent)
            .values({
                auditId: value.auditId,
                projectId: this.#projectId,
                pairingId: value.pairingId,
                runtimeId: value.runtimeId,
                actorKind: value.actorKind,
                actorId: value.actorId,
                action: value.action,
                detailsJson: JSON.stringify(value.details),
                recordedAt: value.recordedAt,
            })
            .onConflictDoNothing();
    };

    readonly readRuntime = async (runtimeId: string, signal: AbortSignal): Promise<RuntimeDirectoryRow | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ ...identityFields, revoked_at: runtimeIdentity.revokedAt, registration: registrationFields })
            .from(runtimeIdentity)
            .leftJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
            .where(and(eq(runtimeIdentity.projectId, this.#projectId), eq(runtimeIdentity.runtimeId, runtimeId)))
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readDaemon = async (channelId: string, tokenHash: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select(identityFields)
            .from(runtimeIdentity)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
            .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.runtimeId, runtimeIdentity.runtimeId))
            .where(
                and(
                    eq(runtimeIdentity.projectId, this.#projectId),
                    eq(runtimeIdentity.channelId, channelId),
                    isNull(runtimeIdentity.revokedAt),
                    eq(runtimeDaemonCredential.tokenHash, tokenHash),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly revokeRuntime = async (
        value: {
            readonly runtimeId: string;
            readonly ownerId: string;
            readonly now: number;
            readonly actorKind: string;
            readonly actorId: string;
            readonly auditId: string;
        },
        signal: AbortSignal,
    ): Promise<RuntimeDirectoryRow | null> => {
        const database = relayDrizzle(this.#database, signal);
        const identity = and(
            eq(runtimeIdentity.projectId, this.#projectId),
            eq(runtimeIdentity.runtimeId, value.runtimeId),
        );
        const channel = database.select({ channelId: runtimeIdentity.channelId }).from(runtimeIdentity).where(identity);
        const revokedAt = database
            .select({ revokedAt: runtimeIdentity.revokedAt })
            .from(runtimeIdentity)
            .where(identity);
        const revocation = database
            .update(runtimeIdentity)
            .set({
                revokedAt: sql`coalesce(${runtimeIdentity.revokedAt}, ${value.now})`,
                revokedByOwnerCredentialId: sql`case when ${runtimeIdentity.revokedAt} is null
                    then ${value.ownerId} else ${runtimeIdentity.revokedByOwnerCredentialId} end`,
            })
            .where(identity);
        const credential = database
            .delete(runtimeDaemonCredential)
            .where(
                and(
                    eq(runtimeDaemonCredential.runtimeId, value.runtimeId),
                    exists(
                        database.select({ runtimeId: runtimeIdentity.runtimeId }).from(runtimeIdentity).where(identity),
                    ),
                ),
            );
        const hosts = database
            .update(channelHostCredential)
            .set({ revokedAt: sql`coalesce(${channelHostCredential.revokedAt}, (${revokedAt}))` })
            .where(eq(channelHostCredential.channelId, channel));
        const grants = database
            .update(channelAccessGrant)
            .set({ expiresAt: sql`min(${channelAccessGrant.expiresAt}, (${revokedAt}))` })
            .where(eq(channelAccessGrant.channelId, channel));
        const audit = database
            .insert(runtimePairingAuditEvent)
            .select(
                database
                    .select({
                        auditId: sql<string>`${value.auditId}`.as("audit_id"),
                        projectId: runtimeIdentity.projectId,
                        pairingId: runtimePairingRequest.pairingId,
                        runtimeId: runtimeIdentity.runtimeId,
                        actorKind: sql<string>`${value.actorKind}`.as("actor_kind"),
                        actorId: sql<string>`${value.actorId}`.as("actor_id"),
                        action: sql<"runtime_pairing.revoked">`'runtime_pairing.revoked'`.as("action"),
                        detailsJson: sql<string>`'{}'`.as("details_json"),
                        recordedAt: sql<number>`${runtimeIdentity.revokedAt}`.as("recorded_at"),
                    })
                    .from(runtimeIdentity)
                    .innerJoin(runtimePairingRequest, eq(runtimePairingRequest.runtimeId, runtimeIdentity.runtimeId))
                    .where(identity),
            )
            .onConflictDoNothing();
        const results = await this.#database.batch(
            [revocation, credential, hosts, grants, audit].map(this.statement),
            signal,
        );
        // All writers preserve the first revocation time. Reading the committed
        // fact also makes overlapping retries return that same timestamp.
        return results[0]?.meta.changes === 1 ? this.readRuntime(value.runtimeId, signal) : null;
    };

    readonly listRuntimes = async (signal: AbortSignal) => {
        const results = await relayDrizzle(this.#database, signal)
            .select({ ...identityFields, ...registrationFields })
            .from(runtimeIdentity)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
            .where(and(eq(runtimeIdentity.projectId, this.#projectId), isNull(runtimeIdentity.revokedAt)))
            .orderBy(runtimeIdentity.createdAt, runtimeIdentity.channelId)
            .limit(100);
        return { results };
    };

    readonly readChannel = async (channelId: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ ...identityFields, ...registrationFields })
            .from(runtimeIdentity)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
            .where(
                and(
                    eq(runtimeIdentity.projectId, this.#projectId),
                    eq(runtimeIdentity.channelId, channelId),
                    isNull(runtimeIdentity.revokedAt),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly updateAgents = async (channelId: string, tokenHash: string, agents: string, signal: AbortSignal) => {
        const database = relayDrizzle(this.#database, signal);
        const identity = database
            .select({ runtimeId: runtimeIdentity.runtimeId })
            .from(runtimeIdentity)
            .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.runtimeId, runtimeIdentity.runtimeId))
            .where(
                and(
                    eq(runtimeIdentity.projectId, this.#projectId),
                    eq(runtimeIdentity.channelId, channelId),
                    isNull(runtimeIdentity.revokedAt),
                    eq(runtimeDaemonCredential.tokenHash, tokenHash),
                ),
            );
        return this.statement(
            database
                .update(runtimeRegistration)
                .set({ agentsJson: agents })
                .where(eq(runtimeRegistration.runtimeId, identity)),
        ).run(signal);
    };
}
