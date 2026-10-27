import type { DoSqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import {
    runtimeDaemonCredential,
    runtimeIdentity,
    runtimePairingRequest,
    runtimeRegistration,
} from "@moxt-ai/mobius-relay-core/schema/project-do";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { pairingChannel } from "../schema/legacy-project-do/pairing-channel.ts";

// Runs in the same transaction as the generated DROP TABLE migration. Old
// records remain authoritative if validation or any copy fails; a retry cannot
// observe a partially migrated Runtime or silently issue replacement secrets.
export function migrateRuntimePairingRecords(database: DoSqlDatabase): void {
    const orm = database.orm;
    const inconsistent = orm
        .select({ pairingId: pairingChannel.pairingId })
        .from(pairingChannel)
        .where(
            or(
                and(eq(pairingChannel.status, "revoked"), isNull(pairingChannel.revokedAt)),
                and(ne(pairingChannel.status, "revoked"), isNotNull(pairingChannel.revokedAt)),
                and(
                    eq(pairingChannel.status, "paired"),
                    or(isNull(pairingChannel.claimedAt), isNull(pairingChannel.daemonTokenHash)),
                ),
                and(
                    or(eq(pairingChannel.status, "pending"), eq(pairingChannel.status, "expired")),
                    isNotNull(pairingChannel.claimedAt),
                ),
            ),
        )
        .limit(1)
        .get();
    if (inconsistent !== undefined) {
        throw new Error("Cannot migrate an inconsistent Runtime pairing record");
    }
    const projects = orm.selectDistinct({ projectId: pairingChannel.projectId }).from(pairingChannel).limit(2).all();
    if (projects.length > 1) {
        throw new Error("Runtime pairings require Project-scoped storage");
    }
    orm.insert(runtimeIdentity)
        .select(
            orm
                .select({
                    runtimeId: pairingChannel.runtimeId,
                    channelId: pairingChannel.channelId,
                    projectId: pairingChannel.projectId,
                    createdAt: pairingChannel.createdAt,
                    revokedAt: pairingChannel.revokedAt,
                    revokedByOwnerCredentialId: pairingChannel.revokedByOwnerCredentialId,
                })
                .from(pairingChannel),
        )
        .run();
    orm.insert(runtimePairingRequest)
        .select(
            orm
                .select({
                    pairingId: pairingChannel.pairingId,
                    runtimeId: pairingChannel.runtimeId,
                    pairingCodeHash: pairingChannel.pairingCodeHash,
                    pollTokenHash: pairingChannel.pollTokenHash,
                    expiresAt: pairingChannel.expiresAt,
                    creationIdempotencyKey: pairingChannel.creationIdempotencyKey,
                    createdByOwnerCredentialId: pairingChannel.createdByOwnerCredentialId,
                })
                .from(pairingChannel),
        )
        .run();
    orm.insert(runtimeRegistration)
        .select(
            orm
                .select({
                    runtimeId: pairingChannel.runtimeId,
                    claimedAt: sql<number>`${pairingChannel.claimedAt}`.as("claimed_at"),
                    machineName: pairingChannel.machineName,
                    workspaceName: pairingChannel.workspaceName,
                    agentsJson: pairingChannel.agentsJson,
                })
                .from(pairingChannel)
                .where(isNotNull(pairingChannel.claimedAt)),
        )
        .run();
    orm.insert(runtimeDaemonCredential)
        .select(
            orm
                .select({
                    runtimeId: pairingChannel.runtimeId,
                    tokenHash: sql<string>`${pairingChannel.daemonTokenHash}`.as("token_hash"),
                })
                .from(pairingChannel)
                .where(eq(pairingChannel.status, "paired")),
        )
        .run();
}
