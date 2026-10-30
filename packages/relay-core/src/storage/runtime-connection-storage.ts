import type { RuntimeConnectionIdentity } from "../entity/channel/runtime-connection.ts";
import type { ProjectScope } from "../entity/do/session.ts";
import { runtimeConnectionDurableObjectMigrations } from "../generated/runtime-connection-do-migrations.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { applyDurableObjectMigrations } from "../infra/durable-object-migrations.ts";
import { DatabaseError } from "../infra/sql-database.ts";

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

    readonly revoke = (runtimeId: string, scope: ProjectScope, now: number): void => {
        this.#database.run(
            `INSERT INTO runtime_revocations (runtime_id, project_id, revoked_at)
            VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
            [runtimeId, scope.projectId, now],
        );
    };

    readonly read = ():
        | (RuntimeConnectionIdentity & { readonly connectedAt: number; readonly state: "online" | "offline" })
        | null => {
        const row = this.#database.query(`SELECT runtime_id, connection_epoch, connection_id, state, connected_at
            FROM runtime_connection_state WHERE singleton = 1`)[0];
        if (row === undefined) {
            return null;
        }
        const runtimeId = row["runtime_id"];
        const connectionEpoch = row["connection_epoch"];
        const connectionId = row["connection_id"];
        const state = row["state"];
        const connectedAt = row["connected_at"];
        if (
            typeof runtimeId !== "string" ||
            typeof connectionEpoch !== "number" ||
            !Number.isSafeInteger(connectionEpoch) ||
            connectionEpoch < 1 ||
            typeof connectionId !== "string" ||
            (state !== "online" && state !== "offline") ||
            typeof connectedAt !== "number"
        ) {
            throw new DatabaseError("database_unavailable", "The Runtime connection state is invalid");
        }
        return { runtimeId, connectionEpoch, connectionId, connectedAt, state };
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
