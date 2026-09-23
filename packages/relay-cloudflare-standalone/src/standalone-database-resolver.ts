import { D1DatabaseAdapter, type ProjectDatabaseBindings } from "@moxt-ai/mobius-relay-core";

export class StandaloneDatabaseResolver implements ProjectDatabaseBindings {
    readonly #database: D1DatabaseAdapter;

    constructor(database: D1Database) {
        this.#database = D1DatabaseAdapter.from(database);
    }

    readonly resolve: ProjectDatabaseBindings["resolve"] = () => this.#database;
}
