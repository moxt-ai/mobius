import {
    decodeAgentCatalogRefreshCommand,
    decodeAgentSettingsDiscoverCommand,
    decodeNativeSessionRequest,
    decodeWorkspaceListCommand,
    RUNTIME_WORKSPACE_BINDING_ID,
} from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
import { assertExactKeys, bearerToken, readString } from "../../infra/relay-http.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createProjectRuntimeRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .get("/projects/:projectId/runtimes", async (context) => {
            const runtimes = await context.env.services.runtimePairings.listProjectRuntimes(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({ runtimes });
        })
        .post(
            "/projects/:projectId/runtimes/:runtimeId/agent-catalog/refresh",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                assertExactKeys(context.req.valid("json"), []);
                const command = decodeAgentCatalogRefreshCommand(
                    JSON.stringify({ kind: "agent.catalog.refresh", requestId: crypto.randomUUID() }),
                );
                await context.env.services.runtimePairings.refreshAgentCatalog(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                context.header("Cache-Control", "no-store");
                return context.json({ ok: true });
            },
        )
        .post(
            "/projects/:projectId/runtimes/:runtimeId/agents/:agentId/settings",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = context.req.valid("json");
                if (Object.keys(body).some((key) => key !== "model")) {
                    throw new PairingDirectoryError("invalid_request", "The request fields are invalid");
                }
                const model = body["model"] === undefined ? undefined : readString(body, "model", 500);
                const command = decodeAgentSettingsDiscoverCommand(
                    JSON.stringify({
                        agentId: validateIdentifier(context.req.param("agentId"), "agent_id"),
                        kind: "agent.settings.discover",
                        ...(model === undefined ? {} : { model }),
                        requestId: crypto.randomUUID(),
                    }),
                );
                const result = await context.env.services.runtimePairings.discoverAgentSettings(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post(
            "/projects/:projectId/runtimes/:runtimeId/native-sessions",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = context.req.valid("json");
                if (
                    body["action"] !== "create" &&
                    body["action"] !== "list" &&
                    body["action"] !== "find" &&
                    body["action"] !== "import" &&
                    body["action"] !== "fork" &&
                    body["action"] !== "preview"
                ) {
                    throw new PairingDirectoryError("invalid_request", "Choose a supported native session operation");
                }
                assertExactKeys(
                    body,
                    body["action"] === "create"
                        ? ["action", "agentId", "directoryId", "additionalDirectoryIds"]
                        : body["action"] === "list"
                          ? ["action", "agentId", "directoryId", "additionalDirectoryIds", "cursor", "discoveryId"]
                          : body["action"] === "find"
                            ? ["action", "agentId", "directoryId", "additionalDirectoryIds", "nativeSessionId"]
                            : ["action", "agentId", "directoryId", "additionalDirectoryIds", "entryId", "discoveryId"],
                );
                const { discoveryId, ...input } = body;
                const sessionId =
                    input["action"] === "create" ||
                    (input["action"] === "list" && discoveryId === null) ||
                    input["action"] === "find"
                        ? crypto.randomUUID()
                        : validateIdentifier(readString(body, "discoveryId"), "discovery_id");
                const command = decodeNativeSessionRequest(
                    JSON.stringify({
                        ...input,
                        kind: "native.session.request",
                        requestId: crypto.randomUUID(),
                        sessionId,
                        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                        ...(body["action"] === "import" || body["action"] === "fork"
                            ? { targetSessionId: crypto.randomUUID() }
                            : {}),
                    }),
                );
                const result = await context.env.services.runtimePairings.requestControl(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post(
            "/projects/:projectId/runtimes/:runtimeId/workspace",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = context.req.valid("json");
                assertExactKeys(body, ["directoryId"]);
                const command = decodeWorkspaceListCommand(
                    JSON.stringify({
                        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                        directoryId: readString(body, "directoryId", 2_048),
                        kind: "workspace.list",
                        requestId: crypto.randomUUID(),
                    }),
                );
                const result = await context.env.services.runtimePairings.listWorkspace(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        );
}
