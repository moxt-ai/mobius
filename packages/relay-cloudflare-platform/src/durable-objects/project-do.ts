import { DurableObjectDatabaseAdapter, DurableObjectSqlDatabase } from "@moxt-ai/mobius-relay-core";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";
import { decodeProjectDurableObjectPath } from "../entity/project-durable-object-path.ts";
import platformWorker, {
    type ConfiguredPlatformRelayBindings,
    type ProjectPlatformRelayBindings,
} from "../platform-worker.ts";
import { executeProjectDatabaseRequest } from "../storage/project-durable-object-database.ts";
import { initializeProjectDurableObjectSchema } from "../storage/project-durable-object-schema.ts";

export class ProjectDO {
    readonly #database: DurableObjectDatabaseAdapter;
    readonly #sqlite: DurableObjectSqlDatabase;
    readonly #environment: ConfiguredPlatformRelayBindings;

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        this.#environment = environment;
        this.#sqlite = new DurableObjectSqlDatabase(state.storage);
        initializeProjectDurableObjectSchema(this.#sqlite);
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
}
