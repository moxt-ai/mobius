import type { ProjectLocationHint } from "@moxt-ai/mobius-protocol";
import { DatabaseError, type SqlDatabase, type SqlStatement } from "@moxt-ai/mobius-relay-core/database";
import * as v from "valibot";
import { encodeProjectDurableObjectPath } from "../entity/project-durable-object-path.ts";

const sqlValueSchema = v.union([v.null(), v.string(), v.number()]);
const statementSchema = v.object({ sql: v.string(), values: v.array(sqlValueSchema) });
const operationSchema = v.variant("kind", [
    v.object({ kind: v.literal("first"), statement: statementSchema }),
    v.object({ kind: v.literal("all"), statement: statementSchema }),
    v.object({ kind: v.literal("run"), statement: statementSchema }),
    v.object({ kind: v.literal("batch"), statements: v.array(statementSchema) }),
]);
const rowSchema = v.record(v.string(), v.unknown());
const resultSchema = v.object({ results: v.array(rowSchema), meta: v.object({ changes: v.number() }) });

type SqlValue = Readonly<v.InferOutput<typeof sqlValueSchema>>;
type Statement = Readonly<v.InferOutput<typeof statementSchema>>;
type Operation = Readonly<v.InferOutput<typeof operationSchema>>;

function sqlValue(value: unknown): SqlValue {
    const parsed = v.safeParse(sqlValueSchema, value);
    if (!parsed.success) {
        throw new DatabaseError("database_statement_invalid", "Project SQLite received an unsupported bound value");
    }
    return parsed.output;
}

function decodeRow<Row>(value: unknown): Row {
    return JSON.parse(JSON.stringify(v.parse(rowSchema, value)));
}

async function requestDatabase(
    namespace: DurableObjectNamespace,
    projectId: string,
    locationHint: ProjectLocationHint,
    operation: Operation,
    signal: AbortSignal,
): Promise<unknown> {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("Project database request timed out")), 15_000);
    const deadline = AbortSignal.any([signal, timeout.signal]);
    try {
        const response = await namespace
            .getByName(projectId, { locationHint })
            .fetch(`https://project.internal${encodeProjectDurableObjectPath(projectId, "/database")}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(operation),
                signal: deadline,
            });
        deadline.throwIfAborted();
        if (!response.ok) {
            throw new Error("Project database rejected the operation");
        }
        return await response.json();
    } catch (cause) {
        signal.throwIfAborted();
        throw new DatabaseError(
            timeout.signal.aborted ? "database_timeout" : "database_unavailable",
            "Project storage is unavailable",
            { cause },
        );
    } finally {
        clearTimeout(timer);
    }
}

class ProjectDurableObjectStatement implements SqlStatement {
    readonly namespace: DurableObjectNamespace;
    readonly projectId: string;
    readonly locationHint: ProjectLocationHint;
    readonly statement: Statement;

    constructor(
        namespace: DurableObjectNamespace,
        projectId: string,
        locationHint: ProjectLocationHint,
        statement: Statement,
    ) {
        this.namespace = namespace;
        this.projectId = projectId;
        this.locationHint = locationHint;
        this.statement = statement;
    }

    readonly bind: SqlStatement["bind"] = (...values) =>
        new ProjectDurableObjectStatement(this.namespace, this.projectId, this.locationHint, {
            ...this.statement,
            values: values.map(sqlValue),
        });

    readonly first: SqlStatement["first"] = async <Row>(signal: AbortSignal) => {
        const value = await requestDatabase(
            this.namespace,
            this.projectId,
            this.locationHint,
            { kind: "first", statement: this.statement },
            signal,
        );
        return value === null ? null : decodeRow<Row>(value);
    };

    readonly all: SqlStatement["all"] = async <Row>(signal: AbortSignal) => {
        const value = v.parse(
            resultSchema,
            await requestDatabase(
                this.namespace,
                this.projectId,
                this.locationHint,
                { kind: "all", statement: this.statement },
                signal,
            ),
        );
        return { results: value.results.map(decodeRow<Row>), meta: value.meta };
    };

    readonly run: SqlStatement["run"] = async (signal) =>
        v.parse(
            resultSchema,
            await requestDatabase(
                this.namespace,
                this.projectId,
                this.locationHint,
                { kind: "run", statement: this.statement },
                signal,
            ),
        );
}

export class ProjectDurableObjectDatabase implements SqlDatabase {
    readonly #namespace: DurableObjectNamespace;
    readonly #projectId: string;
    readonly #locationHint: ProjectLocationHint;

    constructor(namespace: DurableObjectNamespace, projectId: string, locationHint: ProjectLocationHint) {
        this.#namespace = namespace;
        this.#projectId = projectId;
        this.#locationHint = locationHint;
    }

    readonly prepare: SqlDatabase["prepare"] = (sql) =>
        new ProjectDurableObjectStatement(this.#namespace, this.#projectId, this.#locationHint, { sql, values: [] });

    readonly batch: SqlDatabase["batch"] = async (statements, signal) => {
        const encoded: Statement[] = [];
        for (const statement of statements) {
            if (
                !(statement instanceof ProjectDurableObjectStatement) ||
                statement.namespace !== this.#namespace ||
                statement.projectId !== this.#projectId ||
                statement.locationHint !== this.#locationHint
            ) {
                throw new DatabaseError("database_statement_invalid", "SQL statements must belong to one Project");
            }
            encoded.push(statement.statement);
        }
        const value = await requestDatabase(
            this.#namespace,
            this.#projectId,
            this.#locationHint,
            { kind: "batch", statements: encoded },
            signal,
        );
        return v.parse(v.array(resultSchema), value);
    };
}

export async function executeProjectDatabaseRequest(request: Request, database: SqlDatabase): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).hostname !== "project.internal") {
        return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
    }
    const parsed = v.safeParse(operationSchema, await request.json());
    if (!parsed.success) {
        return Response.json(
            { error: { code: "invalid_request", message: "Invalid database operation" } },
            { status: 400 },
        );
    }
    const operation = parsed.output;
    const prepared = (statement: Statement) => database.prepare(statement.sql).bind(...statement.values);
    switch (operation.kind) {
        case "first":
            return Response.json(await prepared(operation.statement).first(request.signal));
        case "all":
            return Response.json(await prepared(operation.statement).all(request.signal));
        case "run":
            return Response.json(await prepared(operation.statement).run(request.signal));
        case "batch":
            return Response.json(await database.batch(operation.statements.map(prepared), request.signal));
    }
}
