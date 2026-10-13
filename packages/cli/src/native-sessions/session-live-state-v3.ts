import {
    type SessionLiveEventItemV3,
    type SessionLiveEventV3,
    sessionLiveEventItemV3Schema,
} from "@moxt-ai/mobius-protocol";
import { eq } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { sessionLiveSequenceV3 } from "../schema/session-live-state/index.ts";

export class SessionLiveStateV3 {
    readonly #database: NodeSQLiteDatabase;
    readonly #localDatabase: LocalSqliteDatabase;

    constructor(localDatabase: LocalSqliteDatabase) {
        this.#localDatabase = localDatabase;
        this.#database = localDatabase.orm;
    }

    readonly commit = (sessionId: string, untrustedItem: SessionLiveEventItemV3): SessionLiveEventV3 => {
        const item = sessionLiveEventItemV3Schema.parse(untrustedItem);
        return this.#localDatabase.transaction(() => {
            const current = this.#database
                .select({ maxSeq: sessionLiveSequenceV3.maxSeq })
                .from(sessionLiveSequenceV3)
                .where(eq(sessionLiveSequenceV3.sessionId, sessionId))
                .get();
            const seq = current === undefined ? 1 : current.maxSeq + 1;
            if (!Number.isSafeInteger(seq)) {
                throw new Error("The V3 Session live sequence is exhausted");
            }
            this.#database
                .insert(sessionLiveSequenceV3)
                .values({ maxSeq: seq, sessionId })
                .onConflictDoUpdate({ target: sessionLiveSequenceV3.sessionId, set: { maxSeq: seq } })
                .run();
            return { item, seq, sessionId };
        });
    };
}
