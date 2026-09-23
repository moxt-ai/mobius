import { and, eq, isNull } from "drizzle-orm";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { channelHostCredential, pairingChannel } from "../schema/d1/index.ts";

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
                    database.$count(
                        channelHostCredential,
                        and(
                            eq(channelHostCredential.credentialId, identity.credentialId),
                            eq(channelHostCredential.channelId, pairingChannel.channelId),
                            isNull(channelHostCredential.revokedAt),
                        ),
                    ),
                ),
            )
            .limit(1);
        return channels.length === 0 ? null : { active: 1 };
    };
}
