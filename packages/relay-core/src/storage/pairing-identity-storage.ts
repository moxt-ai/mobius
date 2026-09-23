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
    pairingChannel,
    projectBrowserCredential,
} from "../schema/d1/index.ts";

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
                .selectDistinct({ project_id: pairingChannel.projectId })
                .from(pairingChannel)
                .innerJoin(channelHostCredential, eq(channelHostCredential.channelId, pairingChannel.channelId))
                .where(
                    and(
                        eq(pairingChannel.channelId, validateIdentifier(credential.channelId, "channel_id")),
                        eq(channelHostCredential.tokenHash, credential.tokenHash),
                        isNull(channelHostCredential.revokedAt),
                        eq(pairingChannel.status, "paired"),
                        or(
                            isNull(channelHostCredential.replacedByCredentialId),
                            gt(channelHostCredential.overlapEndsAt, Date.now()),
                        ),
                    ),
                );
        case "daemon":
            return orm
                .select({ project_id: pairingChannel.projectId })
                .from(pairingChannel)
                .where(
                    and(
                        eq(pairingChannel.channelId, validateIdentifier(credential.channelId, "channel_id")),
                        eq(pairingChannel.daemonTokenHash, credential.tokenHash),
                        eq(pairingChannel.status, "paired"),
                    ),
                );
        case "project": {
            const projectId = validateIdentifier(credential.projectId, "project_id");
            const [hosts, browsers] = await Promise.all([
                orm
                    .selectDistinct({ project_id: pairingChannel.projectId })
                    .from(pairingChannel)
                    .innerJoin(channelHostCredential, eq(channelHostCredential.channelId, pairingChannel.channelId))
                    .where(
                        and(
                            eq(pairingChannel.projectId, projectId),
                            eq(channelHostCredential.tokenHash, credential.tokenHash),
                            isNull(channelHostCredential.revokedAt),
                            eq(pairingChannel.status, "paired"),
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
                .select({ project_id: pairingChannel.projectId })
                .from(pairingChannel)
                .where(
                    and(
                        eq(pairingChannel.pairingId, validateIdentifier(credential.pairingId, "pairing_id")),
                        eq(pairingChannel.pollTokenHash, credential.tokenHash),
                    ),
                );
        case "pairing-code":
            return orm
                .select({ project_id: pairingChannel.projectId })
                .from(pairingChannel)
                .where(eq(pairingChannel.pairingCodeHash, credential.codeHash));
        case "grant":
            return orm
                .select({ project_id: pairingChannel.projectId })
                .from(channelAccessGrant)
                .innerJoin(pairingChannel, eq(pairingChannel.channelId, channelAccessGrant.channelId))
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
                    project_id: pairingChannel.projectId,
                    runtime_id: pairingChannel.runtimeId,
                    channel_id: pairingChannel.channelId,
                    pairing_id: pairingChannel.pairingId,
                })
                .from(pairingChannel)
                .where(and(eq(pairingChannel.daemonTokenHash, tokenHash), eq(pairingChannel.status, "paired")));
            for (const row of rows) {
                matches.push({ sourceId: source.sourceId, row });
            }
        }
        return matches;
    };
}
