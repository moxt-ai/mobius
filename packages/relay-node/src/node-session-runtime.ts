import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type SessionQuotaPolicy, SqliteSessionRuntime } from "@moxt-ai/mobius-relay-core";

import { FilesystemContentStore } from "./filesystem-content-store.ts";
import { NodeSqlDatabase } from "./node-sql-database.ts";

export class NodeSessionRuntime extends SqliteSessionRuntime {
    readonly #database: NodeSqlDatabase;

    constructor(databasePath: string, contentRoot: string, quota?: SessionQuotaPolicy) {
        mkdirSync(dirname(databasePath), { recursive: true });
        const database = new NodeSqlDatabase(databasePath);
        super(database, new FilesystemContentStore(contentRoot), quota);
        this.#database = database;
    }

    readonly close = (): void => {
        this.closeEventStreams();
        this.#database.close();
    };
}
