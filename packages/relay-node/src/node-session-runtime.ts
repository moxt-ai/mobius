import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type SessionQuotaPolicy, SqliteSessionRuntime } from "@moxt-ai/mobius-relay-core";

import { FilesystemContentStore } from "./filesystem-content-store.ts";
import { NodeSqlDatabase } from "./node-sql-database.ts";

export class NodeSessionRuntime extends SqliteSessionRuntime {
    readonly #database: NodeSqlDatabase;

    constructor(cx: {
        readonly config: {
            readonly databasePath: string;
            readonly contentRoot: string;
            readonly quota?: SessionQuotaPolicy;
        };
    }) {
        const { databasePath, contentRoot } = cx.config;
        mkdirSync(dirname(databasePath), { recursive: true });
        const database = new NodeSqlDatabase(databasePath);
        super({ gateways: { database, content: new FilesystemContentStore(contentRoot) }, config: cx.config });
        this.#database = database;
    }

    readonly close = (): void => {
        this.closeEventStreams();
        this.#database.close();
    };
}
