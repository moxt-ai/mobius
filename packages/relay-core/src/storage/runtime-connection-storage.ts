import * as v from "valibot";
import type {
    RuntimeConnectionIdentity,
    RuntimeDisconnect,
    RuntimeDisconnectTarget,
} from "../entity/channel/runtime-connection.ts";
import type { ProjectScope } from "../entity/do/session.ts";
import { runtimeConnectionDurableObjectMigrations } from "../generated/runtime-connection-do-migrations.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { applyDurableObjectMigrations } from "../infra/durable-object-migrations.ts";
import { DatabaseError } from "../infra/sql-database.ts";

const disconnectSchema = v.object({
    runtimeId: v.string(),
    connectionEpoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    connectionId: v.string(),
    projectId: v.string(),
    disconnectedAt: v.number(),
});

export class RuntimeConnectionStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
        applyDurableObjectMigrations(database, "runtime-connection-do", runtimeConnectionDurableObjectMigrations);
    }

    readonly isRevoked = (runtimeId: string, scope: ProjectScope): boolean =>
        this.#database.query(
            `SELECT 1 FROM runtime_revocations
            WHERE runtime_id = ? AND project_id = ?`,
            [runtimeId, scope.projectId],
        )[0] !== undefined;

    /**
     * Remember that this Runtime still has work for a Session.
     *
     * Only a Session the Channel handed work to can be in flight, so recording these keeps a disconnect sweep
     * proportional to the Runtime's outstanding work instead of the Project's Session count. A Session whose
     * Turn already finished is never recorded, so it is never revisited.
     */
    readonly recordActiveSession = (
        runtimeId: string,
        sessionId: string,
        connectionEpoch: number,
        now: number,
    ): void => {
        this.#database.run(
            `INSERT INTO runtime_active_sessions (runtime_id, session_id, connection_epoch, recorded_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(runtime_id, session_id) DO UPDATE SET
               connection_epoch = excluded.connection_epoch,
               recorded_at = excluded.recorded_at`,
            [runtimeId, sessionId, connectionEpoch, now],
        );
    };

    /**
     * Forget a Session once its in-flight Attempts are settled.
     *
     * Scoping to the recording connection epoch keeps a settle that ran across a reconnect from forgetting a
     * Session the newer connection has since recorded.
     */
    readonly clearActiveSession = (runtimeId: string, sessionId: string, connectionEpoch: number): void => {
        this.#database.run(
            `DELETE FROM runtime_active_sessions
             WHERE runtime_id = ? AND session_id = ? AND connection_epoch = ?`,
            [runtimeId, sessionId, connectionEpoch],
        );
    };

    readonly listActiveSessions = (runtimeId: string): readonly RuntimeDisconnectTarget[] =>
        this.#database
            .query(
                `SELECT session_id, connection_epoch FROM runtime_active_sessions
                 WHERE runtime_id = ?
                 ORDER BY recorded_at, session_id`,
                [runtimeId],
            )
            .map((row) => {
                const sessionId = row["session_id"];
                const connectionEpoch = row["connection_epoch"];
                if (
                    typeof sessionId !== "string" ||
                    sessionId.length === 0 ||
                    typeof connectionEpoch !== "number" ||
                    !Number.isSafeInteger(connectionEpoch) ||
                    connectionEpoch < 1
                ) {
                    throw new DatabaseError("database_unavailable", "The active Session record is invalid");
                }
                return { connectionEpoch, sessionId };
            });

    readonly revoke = (runtimeId: string, scope: ProjectScope, now: number): void => {
        this.#database.run(
            `INSERT INTO runtime_revocations (runtime_id, project_id, revoked_at)
            VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
            [runtimeId, scope.projectId, now],
        );
    };

    readonly pendingDisconnect = (): RuntimeDisconnect | null => {
        const row = this.#database.query("SELECT job_json FROM runtime_disconnect WHERE singleton = 1")[0];
        if (row === undefined) {
            return null;
        }
        try {
            const json = v.parse(v.string(), row["job_json"]);
            const value: unknown = JSON.parse(json);
            return v.parse(disconnectSchema, value);
        } catch (cause) {
            throw new DatabaseError("database_unavailable", "The Runtime disconnect state is invalid", { cause });
        }
    };

    readonly saveDisconnect = (job: RuntimeDisconnect): void => {
        this.#database.run(
            `INSERT INTO runtime_disconnect (singleton, job_json) VALUES (1, ?)
            ON CONFLICT(singleton) DO UPDATE SET job_json = excluded.job_json`,
            [JSON.stringify(job)],
        );
    };

    readonly completeDisconnect = (): void => {
        this.#database.run("DELETE FROM runtime_disconnect WHERE singleton = 1", []);
    };

    readonly read = (): (RuntimeConnectionIdentity & { readonly state: "online" | "offline" }) | null => {
        const row = this.#database.query(`SELECT runtime_id, connection_epoch, connection_id, state
            FROM runtime_connection_state WHERE singleton = 1`)[0];
        if (row === undefined) {
            return null;
        }
        const runtimeId = row["runtime_id"];
        const connectionEpoch = row["connection_epoch"];
        const connectionId = row["connection_id"];
        const state = row["state"];
        if (
            typeof runtimeId !== "string" ||
            typeof connectionEpoch !== "number" ||
            !Number.isSafeInteger(connectionEpoch) ||
            connectionEpoch < 1 ||
            typeof connectionId !== "string" ||
            (state !== "online" && state !== "offline")
        ) {
            throw new DatabaseError("database_unavailable", "The Runtime connection state is invalid");
        }
        return { runtimeId, connectionEpoch, connectionId, state };
    };

    readonly connect = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#database.run(
            `INSERT INTO runtime_connection_state (
            singleton, runtime_id, connection_epoch, connection_id, state, connected_at, disconnected_at
        ) VALUES (1, ?, ?, ?, 'online', ?, NULL)
        ON CONFLICT(singleton) DO UPDATE SET
            runtime_id = excluded.runtime_id,
            connection_epoch = excluded.connection_epoch,
            connection_id = excluded.connection_id,
            state = excluded.state,
            connected_at = excluded.connected_at,
            disconnected_at = NULL`,
            [identity.runtimeId, identity.connectionEpoch, identity.connectionId, now],
        );
    };

    readonly disconnect = (identity: RuntimeConnectionIdentity, now: number): void => {
        this.#database.run(
            `UPDATE runtime_connection_state SET state = 'offline', disconnected_at = ?
            WHERE singleton = 1 AND runtime_id = ? AND connection_epoch = ? AND connection_id = ?`,
            [now, identity.runtimeId, identity.connectionEpoch, identity.connectionId],
        );
    };
}
