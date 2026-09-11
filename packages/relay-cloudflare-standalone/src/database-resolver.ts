import type { ProjectDatabaseBindings } from "@moxt-ai/mobius-relay-core";

export class SingleDatabaseResolver implements ProjectDatabaseBindings {
    readonly #database: D1Database;

    constructor(database: D1Database) {
        this.#database = database;
    }

    readonly resolve: ProjectDatabaseBindings["resolve"] = () => this.#database;
}
