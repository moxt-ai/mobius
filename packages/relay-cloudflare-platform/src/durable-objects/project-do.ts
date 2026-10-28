import {
    DurableObjectDatabaseAdapter,
    DurableObjectSqlDatabase,
    standardWebSocketHost,
} from "@moxt-ai/mobius-relay-core";
import { logger } from "@moxt-ai/mobius-relay-core/logging";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";
import { decodeProjectDurableObjectPath } from "../entity/project-durable-object-path.ts";
import {
    type ConfiguredPlatformRelayBindings,
    createPlatformSocketWorker,
    type ProjectPlatformRelayBindings,
} from "../platform-worker.ts";
import { executeProjectDatabaseRequest } from "../storage/project-durable-object-database.ts";
import { initializeProjectDurableObjectSchema } from "../storage/project-durable-object-schema.ts";

export class ProjectDO {
    readonly #application = createPlatformSocketWorker(standardWebSocketHost);
    readonly #database: DurableObjectDatabaseAdapter;
    readonly #sqlite: DurableObjectSqlDatabase;
    readonly #environment: ConfiguredPlatformRelayBindings;
    readonly #durableObjectId: string;

    constructor(state: DurableObjectState, environment: ConfiguredPlatformRelayBindings) {
        this.#environment = environment;
        this.#durableObjectId = state.id.toString();
        try {
            this.#sqlite = new DurableObjectSqlDatabase(state.storage);
            initializeProjectDurableObjectSchema(this.#sqlite);
            this.#database = new DurableObjectDatabaseAdapter(state.storage);
        } catch (error) {
            logger.error(
                {
                    event: "project_do_initialization_failed",
                    durableObjectClass: "ProjectDO",
                    durableObjectId: this.#durableObjectId,
                    err: error,
                },
                "Project Durable Object initialization failed",
            );
            throw error;
        }
    }

    readonly fetch = async (request: Request): Promise<Response> => {
        const requestUrl = new URL(request.url);
        const projectPath = decodeProjectDurableObjectPath(requestUrl.pathname);
        try {
            const placement = projectPath === null ? null : decodePlatformProjectPlacement(projectPath.projectId);
            if (projectPath === null || placement === null) {
                return Response.json(
                    { error: { code: "project_id_invalid", message: "The Project identifier is invalid" } },
                    { status: 400 },
                );
            }
            const projectId = projectPath.projectId;
            const identity = this.#sqlite.query(
                "SELECT project_id FROM project_object_identity WHERE singleton = 1",
            )[0];
            if (identity === undefined) {
                this.#sqlite.run("INSERT INTO project_object_identity (singleton, project_id) VALUES (1, ?)", [
                    projectId,
                ]);
            } else if (identity["project_id"] !== projectId) {
                return Response.json(
                    { error: { code: "project_id_mismatch", message: "The Project is unavailable" } },
                    { status: 421 },
                );
            }
            if (requestUrl.hostname === "project.internal") {
                return await executeProjectDatabaseRequest(request, this.#database);
            }
            requestUrl.pathname = projectPath.requestPathname;
            const routedRequest = new Request(requestUrl, request);
            const environment: ConfiguredPlatformRelayBindings & ProjectPlatformRelayBindings = {
                ...this.#environment,
                MOBIUS_PROJECT_DATABASE: this.#database,
                MOBIUS_PROJECT_ID: projectId,
            };
            return await this.#application.fetch(routedRequest, environment);
        } catch (error) {
            request.signal.throwIfAborted();
            logger.error(
                {
                    event: "project_do_request_failed",
                    durableObjectClass: "ProjectDO",
                    durableObjectId: this.#durableObjectId,
                    projectId: projectPath?.projectId ?? null,
                    method: request.method,
                    path: projectPath?.requestPathname ?? requestUrl.pathname,
                    cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                    err: error,
                },
                "Project Durable Object request failed",
            );
            throw error;
        }
    };
}
