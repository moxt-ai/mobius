import { and, eq, isNull, or } from "drizzle-orm";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { channelHostCredential, pairingChannel, projectOwnerCredential } from "../schema/index.ts";

export interface ChannelCredentialIdentity {
    readonly channelId: string;
    readonly credentialId: string;
    readonly projectId: string;
    readonly runtimeId: string;
}

export class ChannelCredentialStorage {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readActive = async (identity: ChannelCredentialIdentity, signal: AbortSignal) => {
        const database = relayDrizzle(this.#database, signal);
        const channels = await database
            .select({ channelId: pairingChannel.channelId })
            .from(pairingChannel)
            .where(
                and(
                    eq(pairingChannel.channelId, identity.channelId),
                    eq(pairingChannel.runtimeId, identity.runtimeId),
                    eq(pairingChannel.projectId, identity.projectId),
                    eq(pairingChannel.status, "paired"),
                    or(
                        database.$count(
                            channelHostCredential,
                            and(
                                eq(channelHostCredential.credentialId, identity.credentialId),
                                eq(channelHostCredential.channelId, pairingChannel.channelId),
                                isNull(channelHostCredential.revokedAt),
                            ),
                        ),
                        database.$count(
                            projectOwnerCredential,
                            and(
                                eq(projectOwnerCredential.credentialId, identity.credentialId),
                                eq(projectOwnerCredential.projectId, pairingChannel.projectId),
                                isNull(projectOwnerCredential.revokedAt),
                            ),
                        ),
                    ),
                ),
            )
            .limit(1);
        return channels.length === 0 ? null : { active: 1 };
    };
}
