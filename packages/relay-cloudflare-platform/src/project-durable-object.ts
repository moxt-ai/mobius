import { DurableObjectDatabaseAdapter, DurableObjectSqlDatabase } from "@moxt-ai/mobius-relay-core";
import { decodePlatformProjectPlacement } from "./entity/platform-project-id.ts";
import { decodeProjectDurableObjectPath } from "./entity/project-durable-object-path.ts";
import platformWorker, {
    type ConfiguredPlatformRelayBindings,
    type ProjectPlatformRelayBindings,
} from "./platform-worker.ts";
import { executeProjectDatabaseRequest } from "./storage/project-durable-object-database.ts";
import { initializeProjectDurableObjectSchema } from "./storage/project-durable-object-schema.ts";

const MIGRATION_SESSION_LIMIT = 25;

function identifier(value: unknown): string | null {
    return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.freeze(Object.fromEntries(Object.entries(value)))
        : null;
}

export class ProjectRelay {
    readonly #database: DurableObjectDatabaseAdapter;
    readonly #sqlite: DurableObjectSqlDatabase;
    readonly #environment: ConfiguredPlatformRelayBindings;

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        this.#environment = environment;
        this.#sqlite = new DurableObjectSqlDatabase(state.storage);
        initializeProjectDurableObjectSchema(this.#sqlite);
        this.#sqlite.exec(`CREATE TABLE IF NOT EXISTS project_object_identity (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            project_id TEXT NOT NULL UNIQUE
        ) STRICT;`);
        this.#database = new DurableObjectDatabaseAdapter(state.storage);
    }

    readonly fetch = async (request: Request): Promise<Response> => {
        const requestUrl = new URL(request.url);
        const projectPath = decodeProjectDurableObjectPath(requestUrl.pathname);
        const placement = projectPath === null ? null : decodePlatformProjectPlacement(projectPath.projectId);
        if (projectPath === null || placement === null) {
            return Response.json(
                { error: { code: "project_id_invalid", message: "The Project identifier is invalid" } },
                { status: 400 },
            );
        }
        const projectId = projectPath.projectId;
        const identity = this.#sqlite.query("SELECT project_id FROM project_object_identity WHERE singleton = 1")[0];
        if (identity === undefined) {
            this.#sqlite.run("INSERT INTO project_object_identity (singleton, project_id) VALUES (1, ?)", [projectId]);
        } else if (identity["project_id"] !== projectId) {
            return Response.json(
                { error: { code: "project_id_mismatch", message: "The Project is unavailable" } },
                { status: 421 },
            );
        }
        if (new URL(request.url).hostname === "project.internal") {
            if (projectPath.requestPathname === "/migrations/cloud-retention") {
                return await this.migrateCloudRetention(request, projectId, placement.locationHint);
            }
            return await executeProjectDatabaseRequest(request, this.#database);
        }
        requestUrl.pathname = projectPath.requestPathname;
        const routedRequest = new Request(requestUrl, request);
        const environment: ConfiguredPlatformRelayBindings & ProjectPlatformRelayBindings = {
            ...this.#environment,
            MOBIUS_PROJECT_DATABASE: this.#database,
            MOBIUS_PROJECT_ID: projectId,
        };
        return await platformWorker.fetch(routedRequest, environment);
    };

    private readonly migrateCloudRetention = async (
        request: Request,
        projectId: string,
        locationHint: NonNullable<ReturnType<typeof decodePlatformProjectPlacement>>["locationHint"],
    ): Promise<Response> => {
        if (request.method !== "POST") {
            return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
        }
        const value = record(await request.json());
        if (value === null) {
            return Response.json(
                { error: { code: "invalid_request", message: "Invalid migration cursor" } },
                { status: 400 },
            );
        }
        const afterSessionId = identifier(value["afterSessionId"]);
        if (value["afterSessionId"] !== "" && afterSessionId === null) {
            return Response.json(
                { error: { code: "invalid_request", message: "Invalid migration cursor" } },
                { status: 400 },
            );
        }
        const rows = this.#sqlite.query(
            `SELECT session_id
               FROM session_directory
              WHERE session_id > ?
              ORDER BY session_id
              LIMIT ?`,
            [afterSessionId ?? "", MIGRATION_SESSION_LIMIT + 1],
        );
        const page = rows.slice(0, MIGRATION_SESSION_LIMIT);
        for (const row of page) {
            request.signal.throwIfAborted();
            const sessionId = identifier(row["session_id"]);
            if (sessionId === null) {
                throw new Error("The Session directory contains an invalid Session identifier");
            }
            const session = this.#environment.SESSION_RELAY.getByName(`platform:${projectId}:${sessionId}`, {
                locationHint,
            });
            const response = await session.fetch("https://session.internal/internal/sessions/migrate-cloud-retention", {
                body: "{}",
                headers: { "content-type": "application/json" },
                method: "POST",
                signal: request.signal,
            });
            await response.body?.cancel();
            if (!response.ok) {
                throw new Error("A Session Durable Object could not be migrated");
            }
        }
        const last = page.at(-1);
        if (rows.length > MIGRATION_SESSION_LIMIT && last !== undefined) {
            return Response.json({
                state: "in_progress",
                migratedSessions: page.length,
                nextAfterSessionId: last["session_id"],
            });
        }
        const sessionCountRow = this.#sqlite.query("SELECT COUNT(*) AS value FROM session_directory")[0];
        const sessionCount = sessionCountRow?.["value"];
        if (typeof sessionCount !== "number" || !Number.isSafeInteger(sessionCount) || sessionCount < 0) {
            throw new Error("The Project Session count is invalid");
        }
        return Response.json({
            state: "complete",
            migratedSessions: page.length,
            sessionCount,
        });
    };
}
