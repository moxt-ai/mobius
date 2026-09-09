import type { DatabaseResolver } from "@moxt-ai/mobius-relay-cloudflare";

export class SingleDatabaseResolver implements DatabaseResolver {
    readonly #database: D1Database;

    constructor(database: D1Database) {
        this.#database = database;
    }

    readonly resolve: DatabaseResolver["resolve"] = () => this.#database;
}
