import { and, eq, isNull } from "drizzle-orm";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { channelHostCredential, runtimeIdentity, runtimeRegistration } from "../schema/project-do/index.ts";

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
            .select({ channelId: runtimeIdentity.channelId })
            .from(runtimeIdentity)
            .innerJoin(runtimeRegistration, eq(runtimeRegistration.runtimeId, runtimeIdentity.runtimeId))
            .where(
                and(
                    eq(runtimeIdentity.channelId, identity.channelId),
                    eq(runtimeIdentity.runtimeId, identity.runtimeId),
                    eq(runtimeIdentity.projectId, identity.projectId),
                    isNull(runtimeIdentity.revokedAt),
                    database.$count(
                        channelHostCredential,
                        and(
                            eq(channelHostCredential.credentialId, identity.credentialId),
                            eq(channelHostCredential.channelId, runtimeIdentity.channelId),
                            isNull(channelHostCredential.revokedAt),
                        ),
                    ),
                ),
            )
            .limit(1);
        return channels.length === 0 ? null : { active: 1 };
    };
}
