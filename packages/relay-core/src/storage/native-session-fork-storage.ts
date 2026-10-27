import { and, eq } from "drizzle-orm";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { nativeSessionFork } from "../schema/runtime-connection-do/index.ts";

export class NativeSessionForkStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
    }

    readonly read = (projectId: string, operationId: string) =>
        this.#database.orm
            .select({ requestHash: nativeSessionFork.requestHash, resultJson: nativeSessionFork.resultJson })
            .from(nativeSessionFork)
            .where(and(eq(nativeSessionFork.projectId, projectId), eq(nativeSessionFork.operationId, operationId)))
            .get();

    readonly start = (projectId: string, operationId: string, requestHash: string): void => {
        this.#database.orm.insert(nativeSessionFork).values({ projectId, operationId, requestHash }).run();
    };

    readonly complete = (projectId: string, operationId: string, resultJson: string): void => {
        this.#database.orm
            .update(nativeSessionFork)
            .set({ resultJson })
            .where(and(eq(nativeSessionFork.projectId, projectId), eq(nativeSessionFork.operationId, operationId)))
            .run();
    };
}
