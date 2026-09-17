import { DurableObjectDatabaseAdapter, DurableObjectSqlDatabase } from "@moxt-ai/mobius-relay-core";
import { decodePlatformProjectPlacement } from "./entity/platform-project-id.ts";
import platformWorker, {
    type ConfiguredPlatformRelayBindings,
    type ProjectPlatformRelayBindings,
} from "./platform-worker.ts";
import { executeProjectDatabaseRequest } from "./storage/project-durable-object-database.ts";
import { initializeProjectDurableObjectSchema } from "./storage/project-durable-object-schema.ts";

function projectIdFromRequest(request: Request): string | null {
    const internal = request.headers.get("x-mobius-project-id");
    if (internal !== null) {
        return internal;
    }
    const match = /\/mobius\/api\/v1\/projects\/([^/]+)/.exec(new URL(request.url).pathname);
    if (match?.[1] === undefined) {
        return null;
    }
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return null;
    }
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
        const projectId = projectIdFromRequest(request);
        if (projectId === null || decodePlatformProjectPlacement(projectId) === null) {
            return Response.json(
                { error: { code: "project_id_invalid", message: "The Project identifier is invalid" } },
                { status: 400 },
            );
        }
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
            return await executeProjectDatabaseRequest(request, this.#database);
        }
        const environment: ConfiguredPlatformRelayBindings & ProjectPlatformRelayBindings = {
            ...this.#environment,
            MOBIUS_PROJECT_DATABASE: this.#database,
            MOBIUS_PROJECT_ID: projectId,
        };
        return await platformWorker.fetch(request, environment);
    };
}
