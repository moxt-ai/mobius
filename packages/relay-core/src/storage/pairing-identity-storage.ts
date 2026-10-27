import { and, eq, gt, isNull, or } from "drizzle-orm";
import { validateIdentifier } from "../entity/pairing/pairing.ts";
import type { PairingIdentityCredential } from "../entity/pairing/pairing-identity.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { ProjectStorageContext } from "../infra/project-storage-directory.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import {
    channelAccessGrant,
    channelHostCredential,
    projectBrowserCredential,
    runtimeDaemonCredential,
    runtimeIdentity,
    runtimePairingRequest,
    runtimeRegistration,
} from "../schema/project-do/index.ts";

export interface IdentityDatabaseSource {
    readonly sourceId: string;
    readonly database: SqlDatabase;
}

async function identityRows(
    database: SqlDatabase,
    credential: PairingIdentityCredential,
    signal: AbortSignal,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const orm = relayDrizzle(database, signal);
    switch (credential.kind) {
        case "host":
            return orm
                .selectDistinct({ project_id: runtimeIdentity.projectId })
                .from(runtimeIdentity)
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
                .innerJoin(channelHostCredential, eq(channelHostCredential.channelId, runtimeIdentity.channelId))
                .where(
                    and(
                        eq(runtimeIdentity.channelId, validateIdentifier(credential.channelId, "channel_id")),
                        eq(channelHostCredential.tokenHash, credential.tokenHash),
                        isNull(channelHostCredential.revokedAt),
                        isNull(runtimeIdentity.revokedAt),
                        or(
                            isNull(channelHostCredential.replacedByCredentialId),
                            gt(channelHostCredential.overlapEndsAt, Date.now()),
                        ),
                    ),
                );
        case "daemon":
            return orm
                .select({ project_id: runtimeIdentity.projectId })
                .from(runtimeIdentity)
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
                .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.runtimeId, runtimeIdentity.runtimeId))
                .where(
                    and(
                        eq(runtimeIdentity.channelId, validateIdentifier(credential.channelId, "channel_id")),
                        eq(runtimeDaemonCredential.tokenHash, credential.tokenHash),
                        isNull(runtimeIdentity.revokedAt),
                    ),
                );
        case "project": {
            const projectId = validateIdentifier(credential.projectId, "project_id");
            const [hosts, browsers] = await Promise.all([
                orm
                    .selectDistinct({ project_id: runtimeIdentity.projectId })
                    .from(runtimeIdentity)
                    .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
                    .innerJoin(channelHostCredential, eq(channelHostCredential.channelId, runtimeIdentity.channelId))
                    .where(
                        and(
                            eq(runtimeIdentity.projectId, projectId),
                            eq(channelHostCredential.tokenHash, credential.tokenHash),
                            isNull(channelHostCredential.revokedAt),
                            isNull(runtimeIdentity.revokedAt),
                        ),
                    ),
                orm
                    .select({
                        project_id: projectBrowserCredential.projectId,
                        expires_at: projectBrowserCredential.expiresAt,
                        revoked_at: projectBrowserCredential.revokedAt,
                    })
                    .from(projectBrowserCredential)
                    .where(
                        and(
                            eq(projectBrowserCredential.projectId, projectId),
                            eq(projectBrowserCredential.tokenHash, credential.tokenHash),
                        ),
                    ),
            ]);
            return [...hosts.map((row) => ({ ...row, expires_at: null, revoked_at: null })), ...browsers];
        }
        case "pairing":
            return orm
                .select({ project_id: runtimeIdentity.projectId })
                .from(runtimePairingRequest)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.runtimeId, runtimePairingRequest.runtimeId))
                .where(
                    and(
                        eq(runtimePairingRequest.pairingId, validateIdentifier(credential.pairingId, "pairing_id")),
                        eq(runtimePairingRequest.pollTokenHash, credential.tokenHash),
                    ),
                );
        case "pairing-code":
            return orm
                .select({ project_id: runtimeIdentity.projectId })
                .from(runtimePairingRequest)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.runtimeId, runtimePairingRequest.runtimeId))
                .where(eq(runtimePairingRequest.pairingCodeHash, credential.codeHash));
        case "grant":
            return orm
                .select({ project_id: runtimeIdentity.projectId })
                .from(channelAccessGrant)
                .innerJoin(runtimeIdentity, eq(runtimeIdentity.channelId, channelAccessGrant.channelId))
                .where(
                    and(
                        eq(channelAccessGrant.channelId, validateIdentifier(credential.channelId, "channel_id")),
                        eq(channelAccessGrant.grantId, validateIdentifier(credential.grantId, "grant_id")),
                        eq(channelAccessGrant.secretHash, credential.secretHash),
                    ),
                );
    }
}

export class PairingIdentityStorage {
    readonly #sources: readonly IdentityDatabaseSource[];
    readonly #databases: DatabaseResolver;
    constructor(sources: readonly IdentityDatabaseSource[], databases: DatabaseResolver) {
        this.#sources = [...sources];
        this.#databases = databases;
    }

    readonly matchesPlacement = (sourceId: string, project: ProjectStorageContext): boolean => {
        const source = this.#sources.find((candidate) => candidate.sourceId === sourceId);
        return source !== undefined && source.database === this.#databases.resolve(project.storagePlacement);
    };

    readonly find = async (credential: PairingIdentityCredential, signal: AbortSignal) => {
        const matches: { readonly sourceId: string; readonly row: Readonly<Record<string, unknown>> }[] = [];
        for (const source of this.#sources) {
            const rows = await identityRows(source.database, credential, signal);
            for (const row of rows) {
                matches.push({ sourceId: source.sourceId, row });
            }
        }
        return matches;
    };

    readonly findRuntime = async (tokenHash: string, signal: AbortSignal) => {
        const matches: { readonly sourceId: string; readonly row: Readonly<Record<string, unknown>> }[] = [];
        for (const source of this.#sources) {
            const rows = await relayDrizzle(source.database, signal)
                .select({
                    project_id: runtimeIdentity.projectId,
                    runtime_id: runtimeIdentity.runtimeId,
                    channel_id: runtimeIdentity.channelId,
                })
                .from(runtimeIdentity)
                .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
                .innerJoin(runtimeDaemonCredential, eq(runtimeDaemonCredential.runtimeId, runtimeIdentity.runtimeId))
                .where(and(eq(runtimeDaemonCredential.tokenHash, tokenHash), isNull(runtimeIdentity.revokedAt)));
            for (const row of rows) {
                matches.push({ sourceId: source.sourceId, row });
            }
        }
        return matches;
    };
}
