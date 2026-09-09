import * as v from "valibot";
import type { RuntimeConnectionIdentity, RuntimeDisconnect } from "../entity/channel/runtime-connection.ts";
import type { ProjectScope } from "../entity/do/session.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { DatabaseError } from "../infra/sql-database.ts";

const disconnectSchema = v.object({
    runtimeId: v.string(),
    connectionEpoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    connectionId: v.string(),
    tenantId: v.string(),
    projectId: v.string(),
    disconnectedAt: v.number(),
    progress: v.variant("kind", [
        v.object({ kind: v.literal("listing") }),
        v.object({ kind: v.literal("disconnecting"), remaining: v.array(v.string()) }),
    ]),
});

export class RuntimeConnectionStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
        database.exec(`CREATE TABLE IF NOT EXISTS runtime_connection_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            runtime_id TEXT NOT NULL,
            connection_epoch INTEGER NOT NULL,
            connection_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('online', 'offline')),
            connected_at INTEGER NOT NULL,
            disconnected_at INTEGER
        ) STRICT;`);
        database.exec(`CREATE TABLE IF NOT EXISTS runtime_disconnect (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            job_json TEXT NOT NULL
        ) STRICT;`);
        database.exec(`CREATE TABLE IF NOT EXISTS runtime_revocations (
            runtime_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            revoked_at INTEGER NOT NULL,
            PRIMARY KEY (runtime_id, tenant_id, project_id)
        ) STRICT;`);
    }

    readonly isRevoked = (runtimeId: string, scope: ProjectScope): boolean =>
        this.#database.query(
            `SELECT 1 FROM runtime_revocations
            WHERE runtime_id = ? AND tenant_id = ? AND project_id = ?`,
            [runtimeId, scope.tenantId, scope.projectId],
        )[0] !== undefined;

    readonly revoke = (runtimeId: string, scope: ProjectScope, now: number): void => {
        this.#database.run(
            `INSERT INTO runtime_revocations (runtime_id, tenant_id, project_id, revoked_at)
            VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            [runtimeId, scope.tenantId, scope.projectId, now],
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
