import {
    decodeAgentSettingsDiscoverCommand,
    decodeNativeSessionRequest,
    decodeSessionCloseCommand,
    decodeSessionConfigReadCommand,
    decodeSessionConfigureCommand,
    decodeSessionListCommand,
    decodeSessionPrepareCommand,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionPromptCommand,
    decodeSessionQueryCommand,
    decodeSessionRenameCommand,
    decodeSessionRestoreCommand,
    decodeWorkspaceListCommand,
    type Identifier,
    isDirectoryIdentifier,
    isIdentifier,
    MAX_DIRECTORY_IDENTIFIER_LENGTH,
    ProtocolMessageError,
    RUNTIME_WORKSPACE_BINDING_ID,
    type SessionPromptCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import { Hono } from "hono";
import * as v from "valibot";
import {
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    validateIdentifier,
} from "../../entity/pairing/pairing.ts";
import { assertRequiredKeys, bearerToken, readString } from "../../infra/relay-http.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";
import { createProjectRuntimeSessionControlRoutes } from "./project-runtime-session-control-routes.ts";

const identifier = v.custom<Identifier>(isIdentifier);
const sessionIdentitySchema = v.strictObject({
    additionalDirectoryIds: v.array(v.custom<string>(isDirectoryIdentifier)),
    agentId: identifier,
    directoryId: v.custom<string>(isDirectoryIdentifier),
});
const createSessionSchema = v.strictObject({
    ...sessionIdentitySchema.entries,
    // Legacy clients send these fields. Workspace authorization and titles belong to the Runtime.
    bindingId: v.optional(identifier),
    runtimeId: identifier,
    sessionId: identifier,
    title: v.optional(v.pipe(v.string(), v.maxLength(512))),
});
const configureSessionSchema = v.strictObject({
    ...sessionIdentitySchema.entries,
    booleanValue: v.boolean(),
    configId: identifier,
    expectedConfigurationRevision: v.optional(identifier),
    value: v.string(),
    valueType: v.picklist(["boolean", "select"]),
});
const renameSessionSchema = v.strictObject({
    title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
});
const nativeEventsSchema = v.strictObject({
    ...sessionIdentitySchema.entries,
    cursor: v.nullable(v.string()),
    eventLimit: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
});
const nativeForkSchema = v.strictObject({
    ...sessionIdentitySchema.entries,
    nativeSessionId: identifier,
});
const sessionQuerySchema = v.strictObject({
    sessionIds: v.pipe(v.array(identifier), v.minLength(1), v.maxLength(500)),
});
const sessionRestoreSchema = v.strictObject({});
const sessionListQuerySchema = v.strictObject({
    limit: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,2}$/), v.transform(Number), v.safeInteger(), v.maxValue(500)),
});
const browserCredentialSchema = v.strictObject({
    expiresInSeconds: v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS / 1_000),
        v.maxValue(MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS / 1_000),
    ),
});
const submitTurnIdentityEntries = {
    ...sessionIdentitySchema.entries,
    content: v.string(),
    disposition: v.picklist(["reject", "queue", "steer"]),
    historyPolicy: v.optional(v.picklist(["eager", "execution-only"])),
    idempotencyKey: identifier,
    sessionConfigurations: v.array(v.unknown()),
    targetCommandId: v.string(),
};
const submitTurnSchema = v.union([
    v.strictObject({
        ...submitTurnIdentityEntries,
        attachments: v.array(v.unknown()),
    }),
    v.strictObject({
        ...submitTurnIdentityEntries,
        images: v.array(v.unknown()),
        resources: v.array(v.unknown()),
    }),
]);

function validated<TSchema extends v.GenericSchema<unknown, object>>(
    schema: TSchema,
    value: Readonly<Record<string, unknown>>,
): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, value);
    if (!result.success) {
        throw new PairingDirectoryError("invalid_request", "The request fields are invalid", { cause: result.issues });
    }
    return result.output;
}

export function createProjectRuntimeRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .route("/", createProjectRuntimeSessionControlRoutes())
        .post("/projects/:projectId/browser-credentials", bodyParser<RelayHttpEnvironment>(), async (context) => {
            const body = validated(browserCredentialSchema, context.req.valid("json"));
            return context.json(
                await context.env.services.runtimePairings.createBrowserCredential(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    body.expiresInSeconds * 1_000,
                    context.req.raw.signal,
                ),
                201,
            );
        })
        .delete("/projects/:projectId/browser-credentials/:credentialId", async (context) => {
            await context.env.services.runtimePairings.revokeBrowserCredential(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                validateIdentifier(context.req.param("credentialId"), "credential_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            return new Response(null, { status: 204 });
        })
        .get("/projects/:projectId/latency", async (context) => {
            await context.env.services.runtimePairings.probeProject(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.body(null, 204);
        })
        .get("/projects/:projectId/runtimes", async (context) => {
            const runtimes = await context.env.services.runtimePairings.listProjectRuntimes(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({ runtimes });
        })
        .get("/projects/:projectId/runtimes/:runtimeId/agents", async (context) => {
            const runtime = await context.env.services.runtimePairings.getRuntimeAgents(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(runtime);
        })
        .get("/projects/:projectId/runtimes/:runtimeId/diagnostics", async (context) => {
            const result = await context.env.services.runtimePairings.readRuntimeDiagnostics(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json(result);
        })
        .get("/projects/:projectId/runtimes/:runtimeId/latency", async (context) => {
            const latencyMs = await context.env.services.runtimePairings.measureRuntimeLatency(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            context.header("Cache-Control", "no-store");
            return context.json({ latencyMs });
        })
        .get("/projects/:projectId/runtimes/:runtimeId/sessions", async (context) => {
            const query = validated(sessionListQuerySchema, { limit: context.req.query("limit") ?? "100" });
            const command = decodeSessionListCommand(
                JSON.stringify({
                    kind: "session.list",
                    limit: query.limit,
                    requestId: crypto.randomUUID(),
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
        })
        .post(
            "/projects/:projectId/runtimes/:runtimeId/sessions/query",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(sessionQuerySchema, context.req.valid("json"));
                const command = decodeSessionQueryCommand(
                    JSON.stringify({
                        kind: "session.query",
                        requestId: crypto.randomUUID(),
                        sessionIds: body.sessionIds,
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
            "/projects/:projectId/runtimes/:runtimeId/sessions",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(createSessionSchema, context.req.valid("json"));
                if (body.runtimeId !== context.req.param("runtimeId")) {
                    throw new PairingDirectoryError("invalid_request", "The Runtime identifier does not match");
                }
                const command = decodeSessionPrepareCommand(
                    JSON.stringify({
                        additionalDirectoryIds: body.additionalDirectoryIds,
                        agentId: body.agentId,
                        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                        directoryId: body.directoryId,
                        kind: "session.prepare",
                        requestId: crypto.randomUUID(),
                        sessionId: body.sessionId,
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
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/load",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(sessionIdentitySchema, context.req.valid("json"));
                const command = decodeSessionPrepareCommand(
                    JSON.stringify({
                        ...body,
                        bindingId: "workspace",
                        kind: "session.prepare",
                        requestId: crypto.randomUUID(),
                        sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
                        sessionState: "provisioned",
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
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/restore",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                validated(sessionRestoreSchema, context.req.valid("json"));
                const command = decodeSessionRestoreCommand(
                    JSON.stringify({
                        kind: "session.restore",
                        requestId: crypto.randomUUID(),
                        sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
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
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/close",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                validated(sessionRestoreSchema, context.req.valid("json"));
                const command = decodeSessionCloseCommand(
                    JSON.stringify({
                        kind: "session.close",
                        requestId: crypto.randomUUID(),
                        sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
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
        .get("/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/configuration", async (context) => {
            const command = decodeSessionConfigReadCommand(
                JSON.stringify({
                    kind: "session.config.read",
                    requestId: crypto.randomUUID(),
                    sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
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
        })
        .post(
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/configuration",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(configureSessionSchema, context.req.valid("json"));
                const command = decodeSessionConfigureCommand(
                    JSON.stringify({
                        ...body,
                        bindingId: "workspace",
                        kind: "session.configure",
                        requestId: crypto.randomUUID(),
                        sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
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
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/rename",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(renameSessionSchema, context.req.valid("json"));
                const command = decodeSessionRenameCommand(
                    JSON.stringify({
                        kind: "session.rename",
                        requestId: crypto.randomUUID(),
                        sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
                        title: body.title,
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
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/native-events-preview",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(nativeEventsSchema, context.req.valid("json"));
                const command = decodeSessionPreviewHistoryPageLoad(
                    JSON.stringify({
                        additionalDirectoryIds: body.additionalDirectoryIds,
                        agentId: body.agentId,
                        cursor: body.cursor,
                        directoryId: body.directoryId,
                        eventLimit: body.eventLimit,
                        bindingId: "workspace",
                        kind: "session.preview-history.page.load",
                        requestId: crypto.randomUUID(),
                        sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
                    }),
                );
                const result = await context.env.services.runtimePairings.requestControl(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                if (result.kind !== "session.preview-history.page.loaded") {
                    throw new PairingDirectoryError(
                        "invalid_request",
                        "The Runtime returned invalid V2 Session events",
                    );
                }
                context.header("Cache-Control", "no-store");
                return context.json(result.events);
            },
        )
        .post(
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/active-turn",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(sessionIdentitySchema, context.req.valid("json"));
                const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
                const result = await context.env.services.runtimePairings.requestControl(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                    bearerToken(context.req.raw),
                    decodeNativeSessionRequest(
                        JSON.stringify({
                            action: "active-turn",
                            ...body,
                            bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                            kind: "native.session.request",
                            requestId: crypto.randomUUID(),
                            sessionId,
                            targetSessionId: sessionId,
                        }),
                    ),
                    context.req.raw.signal,
                );
                if (result.kind !== "native.session.result" || result.action !== "active-turn") {
                    throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid active Turn");
                }
                context.header("Cache-Control", "no-store");
                return context.json(result);
            },
        )
        .post(
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/turns",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(submitTurnSchema, context.req.valid("json"));
                let command: SessionPromptCommand;
                try {
                    command = decodeSessionPromptCommand(
                        JSON.stringify({
                            additionalDirectoryIds: body.additionalDirectoryIds,
                            agentId: body.agentId,
                            bindingId: "workspace",
                            commandId: body.idempotencyKey,
                            directoryId: body.directoryId,
                            disposition: body.disposition,
                            ...(body.historyPolicy === undefined ? {} : { historyPolicy: body.historyPolicy }),
                            attachments: "attachments" in body ? body.attachments : [],
                            kind: "session.prompt",
                            prompt: body.content,
                            sessionConfigurations: body.sessionConfigurations,
                            sessionId: validateIdentifier(context.req.param("sessionId"), "session_id"),
                            targetCommandId: body.targetCommandId,
                        }),
                    );
                } catch (error) {
                    // The caller supplied this prompt, so protocol rejection is a client error, not a retryable outage.
                    if (error instanceof ProtocolMessageError) {
                        throw new PairingDirectoryError("invalid_request", "The Turn request is invalid", {
                            cause: error,
                        });
                    }
                    throw error;
                }
                const result = await context.env.services.runtimePairings.requestControl(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                    bearerToken(context.req.raw),
                    command,
                    context.req.raw.signal,
                );
                if (
                    (result.kind !== "turn.started" && result.kind !== "turn.queued") ||
                    result.commandId !== command.commandId
                ) {
                    throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid Turn");
                }
                context.header("Cache-Control", "no-store");
                return context.json({ turnId: result.commandId });
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
            "/projects/:projectId/runtimes/:runtimeId/native-session-forks/:operationId",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const result = await context.env.services.runtimePairings.forkNativeSession(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("operationId"), "operation_id"),
                    validated(nativeForkSchema, context.req.valid("json")),
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
                    body["action"] !== "list" &&
                    body["action"] !== "find" &&
                    body["action"] !== "import" &&
                    body["action"] !== "fork"
                ) {
                    throw new PairingDirectoryError("invalid_request", "Choose a supported native session operation");
                }
                assertRequiredKeys(
                    body,
                    body["action"] === "list"
                        ? ["action", "agentId", "directoryId", "additionalDirectoryIds", "cursor", "discoveryId"]
                        : body["action"] === "find"
                          ? ["action", "agentId", "directoryId", "additionalDirectoryIds", "nativeSessionId"]
                          : ["action", "agentId", "directoryId", "additionalDirectoryIds", "entryId", "discoveryId"],
                );
                const { discoveryId, ...input } = body;
                const sessionId =
                    (input["action"] === "list" && discoveryId === null) || input["action"] === "find"
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
                assertRequiredKeys(body, ["directoryId"]);
                const view = body["view"];
                if (view !== undefined && view !== "metadata") {
                    throw new PairingDirectoryError("invalid_request", "The workspace view is invalid");
                }
                const command = decodeWorkspaceListCommand(
                    JSON.stringify({
                        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                        directoryId: readString(body, "directoryId", MAX_DIRECTORY_IDENTIFIER_LENGTH),
                        kind: "workspace.list",
                        requestId: crypto.randomUUID(),
                        ...(view === undefined ? {} : { view }),
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
