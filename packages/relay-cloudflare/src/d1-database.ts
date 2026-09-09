import { DatabaseError, type SqlDatabase, type SqlStatement } from "@moxt-ai/mobius-relay-core/database";
import { d1Operation } from "./d1-operation.ts";

class D1Statement implements SqlStatement {
    readonly database: D1Database;
    readonly statement: D1PreparedStatement;
    constructor(database: D1Database, statement: D1PreparedStatement) {
        this.database = database;
        this.statement = statement;
    }

    readonly bind: SqlStatement["bind"] = (...values) => new D1Statement(this.database, this.statement.bind(...values));
    readonly first: SqlStatement["first"] = <Row>(signal: AbortSignal) =>
        d1Operation(() => this.statement.first<Row>(), signal);
    readonly all: SqlStatement["all"] = <Row>(signal: AbortSignal) =>
        d1Operation(() => this.statement.all<Row>(), signal);
    readonly run: SqlStatement["run"] = (signal) => d1Operation(() => this.statement.run(), signal);
}

export class D1DatabaseAdapter implements SqlDatabase {
    static readonly #adapters = new WeakMap<D1Database, D1DatabaseAdapter>();

    static readonly from = (database: D1Database): D1DatabaseAdapter => {
        const existing = D1DatabaseAdapter.#adapters.get(database);
        if (existing !== undefined) {
            return existing;
        }
        const adapter = new D1DatabaseAdapter(database);
        D1DatabaseAdapter.#adapters.set(database, adapter);
        return adapter;
    };
    readonly #database: D1Database;

    constructor(database: D1Database) {
        this.#database = database;
    }

    readonly prepare: SqlDatabase["prepare"] = (sql) => new D1Statement(this.#database, this.#database.prepare(sql));

    readonly batch: SqlDatabase["batch"] = (statements, signal) => {
        const prepared = statements.map((statement) => {
            if (!(statement instanceof D1Statement) || statement.database !== this.#database) {
                throw new DatabaseError("database_statement_invalid", "SQL statements must belong to one database");
            }
            return statement.statement;
        });
        return d1Operation(() => this.#database.batch(prepared), signal);
    };
}
