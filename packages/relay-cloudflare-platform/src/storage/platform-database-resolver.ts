import { D1DatabaseAdapter, type DatabaseResolver } from "@moxt-ai/mobius-relay-cloudflare";

export class PlatformDatabaseResolver implements DatabaseResolver {
    readonly #database: D1DatabaseAdapter;

    constructor(database: D1Database) {
        this.#database = D1DatabaseAdapter.from(database);
    }

    readonly resolve: DatabaseResolver["resolve"] = () => this.#database;
}
