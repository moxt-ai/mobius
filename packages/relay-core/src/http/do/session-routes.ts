import {
    decodeNativeSessionCommand,
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionPermissionRespondCommand,
    decodeSessionPrepareCommand,
    decodeWorkspaceListCommand,
    MOBIUS_SESSION_EXPORT_FORMAT_VERSION,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    type SessionElicitationRespondCommand,
    type SessionPermissionRespondCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
import {
    CreateArtifactUploadRequest,
    CreateSessionBindingRequest,
    SessionRuntimeError,
} from "../../entity/do/session.ts";
import {
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    validateIdentifier,
} from "../../entity/pairing/pairing.ts";
import { RequestBodyError, readBoundedBytesBody } from "../../infra/bounded-request-body.ts";
import {
    assertExactKeys,
    bearerToken,
    createRequest,
    MAX_IMPORT_BODY_LENGTH,
    optionalCursor,
    pageLimit,
    readInteger,
    readString,
    reconciliationOutcome,
} from "../../infra/relay-http.ts";
import { isRecord } from "../../service/do/session-codec.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import { operationTimingMiddleware } from "../middleware/operation-timing-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

function readIdentifierArray(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength: number,
    identifierName: string,
): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > maximumLength) {
        throw new PairingDirectoryError("invalid_request", `The ${key} field is invalid`);
    }
    const identifiers = field.map((identifier) => validateIdentifier(identifier, identifierName));
    if (new Set(identifiers).size !== identifiers.length) {
        throw new PairingDirectoryError("invalid_request", `The ${key} field is invalid`);
    }
    return identifiers;
}

function readSha256(value: Readonly<Record<string, unknown>>, key: string): string {
    const digest = readString(value, key, 64);
    if (!/^[a-f0-9]{64}$/.test(digest)) {
        throw new PairingDirectoryError("invalid_request", `The ${key} field is invalid`);
    }
    return digest;
}

function readPromptDisposition(body: Readonly<Record<string, unknown>>): string {
    const disposition = body["disposition"];
    if (disposition === undefined) {
        return SessionPromptDisposition.Reject;
    }
    if (
        disposition !== SessionPromptDisposition.Reject &&
        disposition !== SessionPromptDisposition.Queue &&
        disposition !== SessionPromptDisposition.Steer
    ) {
        throw new PairingDirectoryError("invalid_request", "The disposition field is invalid");
    }
    return disposition;
}

function readTargetCommandId(body: Readonly<Record<string, unknown>>, disposition: string): string {
    const requestedTarget = body["targetCommandId"] === undefined ? "" : readString(body, "targetCommandId", 128, true);
    const targetCommandId =
        requestedTarget.length === 0 ? "" : validateIdentifier(requestedTarget, "target_command_id");
    if (
        (disposition === SessionPromptDisposition.Reject && targetCommandId.length > 0) ||
        (disposition !== SessionPromptDisposition.Reject && targetCommandId.length === 0)
    ) {
        throw new PairingDirectoryError("invalid_request", "The targetCommandId field is invalid");
    }
    return targetCommandId;
}

export function createSessionRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .use(
            "/projects/:projectId/sessions/:sessionId/:operation{prepare|configuration}",
            operationTimingMiddleware<RelayHttpEnvironment>(),
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
                    body["action"] !== "fork" &&
                    body["action"] !== "preview"
                ) {
                    throw new PairingDirectoryError("invalid_request", "Choose a supported native session operation");
                }
                assertExactKeys(
                    body,
                    body["action"] === "list"
                        ? ["action", "agentId", "directoryId", "additionalDirectoryIds", "cursor", "discoveryId"]
                        : body["action"] === "find"
                          ? ["action", "agentId", "directoryId", "additionalDirectoryIds", "nativeSessionId"]
                          : ["action", "agentId", "directoryId", "additionalDirectoryIds", "entryId", "discoveryId"],
                );
                const { discoveryId, ...input } = body;
                const sourceSessionId =
                    (input["action"] === "list" && discoveryId === null) || input["action"] === "find"
                        ? crypto.randomUUID()
                        : validateIdentifier(readString(body, "discoveryId"), "discovery_id");
                const command = decodeNativeSessionCommand(
                    JSON.stringify({
                        ...input,
                        kind: "native.session.request",
                        requestId: crypto.randomUUID(),
                        sessionId: sourceSessionId,
                        bindingId: "workspace",
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
                        bindingId: "workspace",
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
        )
        .post(
            "/projects/:projectId/sessions/:sessionId/:operation{prepare|configuration}",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const projectId = validateIdentifier(context.req.param("projectId"), "project_id");
                const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
                const token = bearerToken(context.req.raw);
                const signal = context.req.raw.signal;
                const session = await context.var.operationTiming.measure(
                    "session-read",
                    "Read controlled Session",
                    async () => await context.env.services.sessions.readSession(projectId, token, sessionId, signal),
                );
                const body = context.req.valid("json");
                const prepare = context.req.param("operation") === "prepare";
                assertExactKeys(body, prepare ? [] : ["configId", "value", "booleanValue", "valueType"]);
                const identity = {
                    sessionId,
                    requestId: crypto.randomUUID(),
                    agentId: session.agentId,
                    bindingId: session.defaultBinding.bindingId,
                    directoryId: session.defaultBinding.workspaceRef,
                    additionalDirectoryIds: [],
                };
                const encoded = JSON.stringify({
                    ...body,
                    ...identity,
                    kind: prepare ? "session.prepare" : "session.configure",
                });
                return context.json(
                    await context.env.services.runtimePairings.requestControl(
                        projectId,
                        session.runtimeId,
                        token,
                        prepare ? decodeSessionPrepareCommand(encoded) : decodeSessionConfigureCommand(encoded),
                        signal,
                        context.var.operationTiming,
                    ),
                );
            },
        )
        .get("/projects/:projectId/runtimes", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json({
                runtimes: await useCases.listRuntimes(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    context.req.raw.signal,
                ),
            });
        })
        .post(
            "/projects/:projectId/browser-credentials",
            bodyParser<RelayHttpEnvironment>(["expiresInSeconds"]),
            async (context) => {
                const useCases = context.env.services.sessions;
                const body = context.req.valid("json");
                const lifetimeMilliseconds = readInteger(body, "expiresInSeconds") * 1_000;
                if (
                    lifetimeMilliseconds < MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS ||
                    lifetimeMilliseconds > MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS
                ) {
                    throw new PairingDirectoryError("invalid_request", "The browser credential lifetime is invalid");
                }
                return context.json(
                    await useCases.createBrowserCredential(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        lifetimeMilliseconds,
                        context.req.raw.signal,
                    ),
                    201,
                );
            },
        )
        .delete("/projects/:projectId/browser-credentials/:credentialId", async (context) => {
            const useCases = context.env.services.sessions;
            await useCases.revokeBrowserCredential(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                validateIdentifier(context.req.param("credentialId"), "credential_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            return new Response(null, { status: 204 });
        })
        .post("/projects/:projectId/sessions", bodyParser<RelayHttpEnvironment>(), async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.createSession(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    createRequest(context.req.valid("json")),
                    context.env.gateways.nowEpochMilliseconds(),
                    context.req.raw.signal,
                ),
                201,
            );
        })
        .get("/projects/:projectId/sessions", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.listSessions(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    optionalCursor(context.req.query("cursor")),
                    pageLimit(context.req.query("limit")),
                    context.req.raw.signal,
                ),
            );
        })
        .post(
            "/projects/:projectId/session-imports",
            bodyParser<RelayHttpEnvironment>(["formatVersion", "session", "targetBinding"], MAX_IMPORT_BODY_LENGTH),
            async (context) => {
                const useCases = context.env.services.sessions;
                const body = context.req.valid("json");
                if (readString(body, "formatVersion", 32) !== MOBIUS_SESSION_EXPORT_FORMAT_VERSION) {
                    throw new PairingDirectoryError(
                        "invalid_request",
                        "The Session export format version is unsupported",
                    );
                }
                const targetBinding = body["targetBinding"];
                if (!isRecord(targetBinding)) {
                    throw new PairingDirectoryError("invalid_request", "The destination Session binding is invalid");
                }
                assertExactKeys(targetBinding, [
                    "agentRef",
                    "bindingId",
                    "configRevision",
                    "runtimeId",
                    "workspaceRef",
                ]);
                return context.json(
                    await useCases.importSession(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        body["session"],
                        new CreateSessionBindingRequest(
                            validateIdentifier(readString(targetBinding, "bindingId"), "binding_id"),
                            validateIdentifier(readString(targetBinding, "runtimeId"), "runtime_id"),
                            validateIdentifier(readString(targetBinding, "agentRef"), "agent_ref"),
                            validateIdentifier(readString(targetBinding, "workspaceRef"), "workspace_ref"),
                            readInteger(targetBinding, "configRevision"),
                        ),
                        context.env.gateways.nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                    201,
                );
            },
        )
        .get("/projects/:projectId/sessions/:sessionId", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.readSession(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    context.req.raw.signal,
                ),
            );
        })
        .put(
            "/projects/:projectId/sessions/:sessionId/binding",
            bodyParser<RelayHttpEnvironment>(["agentRef", "bindingId", "configRevision", "runtimeId", "workspaceRef"]),
            async (context) => {
                const useCases = context.env.services.sessions;
                const body = context.req.valid("json");
                return context.json(
                    await useCases.setDefaultBinding(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        new CreateSessionBindingRequest(
                            validateIdentifier(readString(body, "bindingId"), "binding_id"),
                            validateIdentifier(readString(body, "runtimeId"), "runtime_id"),
                            validateIdentifier(readString(body, "agentRef"), "agent_ref"),
                            validateIdentifier(readString(body, "workspaceRef"), "workspace_ref"),
                            readInteger(body, "configRevision"),
                        ),
                        context.env.gateways.nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                );
            },
        )
        .get("/projects/:projectId/sessions/:sessionId/turns/:turnId", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.readTurn(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    validateIdentifier(context.req.param("turnId"), "turn_id"),
                    context.req.raw.signal,
                ),
            );
        })
        .post("/projects/:projectId/sessions/:sessionId/turns", bodyParser<RelayHttpEnvironment>(), async (context) => {
            const useCases = context.env.services.sessions;
            const body = context.req.valid("json");
            const legacyFields = [
                "additionalDirectoryIds",
                "artifactIds",
                "content",
                "idempotencyKey",
                "images",
                "resources",
            ];
            const hasDisposition = body["disposition"] !== undefined;
            const hasTargetCommandId = body["targetCommandId"] !== undefined;
            assertExactKeys(
                body,
                hasDisposition && hasTargetCommandId
                    ? [...legacyFields, "disposition", "targetCommandId"]
                    : legacyFields,
            );
            const additionalDirectoryIds = readIdentifierArray(body, "additionalDirectoryIds", 16, "directory_id");
            const artifactIds = readIdentifierArray(body, "artifactIds", 16, "artifact_id");
            const disposition = readPromptDisposition(body);
            const targetCommandId = readTargetCommandId(body, disposition);
            return context.json(
                await useCases.submitTurn(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    validateIdentifier(readString(body, "idempotencyKey"), "idempotency_key"),
                    readString(body, "content", 100_000, true),
                    disposition,
                    targetCommandId,
                    additionalDirectoryIds,
                    decodePromptImagesValue(body["images"]),
                    decodePromptResourcesValue(body["resources"]),
                    artifactIds,
                    context.env.gateways.nowEpochMilliseconds(),
                    context.req.raw.signal,
                ),
                202,
            );
        })
        .post(
            "/projects/:projectId/sessions/:sessionId/artifacts/uploads",
            bodyParser<RelayHttpEnvironment>(["byteLength", "mediaType", "name", "sha256"]),
            async (context) => {
                const useCases = context.env.services.sessions;
                const body = context.req.valid("json");
                return context.json(
                    await useCases.createArtifactUpload(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        new CreateArtifactUploadRequest(
                            readString(body, "name", 500),
                            readString(body, "mediaType", 255),
                            readInteger(body, "byteLength"),
                            readSha256(body, "sha256"),
                        ),
                        context.env.gateways.nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                    201,
                );
            },
        )
        .put("/projects/:projectId/sessions/:sessionId/artifacts/:artifactId/content", async (context) => {
            const useCases = context.env.services.sessions;
            const projectId = validateIdentifier(context.req.param("projectId"), "project_id");
            const lease = await useCases.authorizeArtifactUpload(
                projectId,
                bearerToken(context.req.raw),
                validateIdentifier(context.req.param("sessionId"), "session_id"),
                validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                context.req.header("x-mobius-upload-token") ?? "",
                context.env.gateways.nowEpochMilliseconds(),
                context.req.raw.signal,
            );
            if (context.req.header("content-type") !== lease.artifact.mediaType) {
                throw new SessionRuntimeError(
                    "artifact_content_mismatch",
                    "The artifact media type does not match its authorization",
                );
            }
            let bytes: Uint8Array;
            try {
                bytes = await readBoundedBytesBody(context.req.raw, lease.artifact.byteLength);
            } catch (cause) {
                if (cause instanceof RequestBodyError) {
                    throw new SessionRuntimeError(
                        "artifact_content_mismatch",
                        "The artifact body does not match its authorization",
                        { cause },
                    );
                }
                throw cause;
            }
            return context.json(
                await useCases.completeArtifactUpload(
                    projectId,
                    bearerToken(context.req.raw),
                    lease,
                    bytes,
                    context.env.gateways.nowEpochMilliseconds(),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/projects/:projectId/sessions/:sessionId/artifacts/:artifactId", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.readArtifact(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                    context.env.gateways.nowEpochMilliseconds(),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/projects/:projectId/sessions/:sessionId/artifacts/:artifactId/content", async (context) => {
            const useCases = context.env.services.sessions;
            const content = await useCases.readArtifactContent(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                bearerToken(context.req.raw),
                validateIdentifier(context.req.param("sessionId"), "session_id"),
                validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                context.req.raw.signal,
            );
            return new Response(Uint8Array.from(content.bytes), {
                headers: {
                    "content-length": content.bytes.byteLength.toString(),
                    "content-type": content.artifact.mediaType,
                    "x-mobius-artifact-id": content.artifact.artifactId,
                    "x-mobius-sha256": content.artifact.sha256,
                },
            });
        })
        .post(
            "/projects/:projectId/sessions/:sessionId/turns/:turnId/cancel",
            bodyParser<RelayHttpEnvironment>(["idempotencyKey"]),
            async (context) => {
                const useCases = context.env.services.sessions;
                const body = context.req.valid("json");
                return context.json(
                    await useCases.cancelTurn(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(context.req.param("turnId"), "turn_id"),
                        validateIdentifier(readString(body, "idempotencyKey"), "idempotency_key"),
                        context.env.gateways.nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                    202,
                );
            },
        )
        .put(
            "/projects/:projectId/sessions/:sessionId/turns/:turnId/disposition",
            bodyParser<RelayHttpEnvironment>(["disposition"]),
            async (context) => {
                const useCases = context.env.services.sessions;
                const body = context.req.valid("json");
                if (readPromptDisposition(body) !== SessionPromptDisposition.Steer) {
                    throw new PairingDirectoryError(
                        "invalid_request",
                        "A queued Turn can only be promoted to steering",
                    );
                }
                return context.json(
                    await useCases.promoteQueuedTurnToSteering(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(context.req.param("turnId"), "turn_id"),
                        context.env.gateways.nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                );
            },
        )
        .get("/projects/:projectId/sessions/:sessionId/attempts/:attemptId", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.readAttempt(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    validateIdentifier(context.req.param("attemptId"), "attempt_id"),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/projects/:projectId/sessions/:sessionId/interactions", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json({
                interactions: await useCases.readPendingInteractions(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    context.req.raw.signal,
                ),
            });
        })
        .get("/projects/:projectId/sessions/:sessionId/interactions/:interactionId", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.readInteraction(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    validateIdentifier(context.req.param("interactionId"), "interaction_id"),
                    context.req.raw.signal,
                ),
            );
        })
        .post(
            "/projects/:projectId/sessions/:sessionId/interactions/:interactionId/responses",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const useCases = context.env.services.sessions;
                const body = context.req.valid("json");
                const projectId = validateIdentifier(context.req.param("projectId"), "project_id");
                const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
                const interactionId = validateIdentifier(context.req.param("interactionId"), "interaction_id");
                const responderId = validateIdentifier(readString(body, "responderId"), "responder_id");
                const kind = readString(body, "kind", 32);
                if (kind === "permission") {
                    assertExactKeys(body, ["kind", "optionId", "outcome", "responderId"]);
                    let command: SessionPermissionRespondCommand;
                    try {
                        command = decodeSessionPermissionRespondCommand(
                            JSON.stringify({
                                interactionId,
                                kind: SESSION_PERMISSION_RESPOND_KIND,
                                optionId: readString(body, "optionId", 255),
                                outcome: readString(body, "outcome", 32),
                                sessionId,
                            }),
                        );
                    } catch (cause) {
                        throw new PairingDirectoryError("invalid_request", "The permission response is invalid", {
                            cause,
                        });
                    }
                    return context.json(
                        await useCases.respondToPermission(
                            projectId,
                            bearerToken(context.req.raw),
                            responderId,
                            command,
                            context.env.gateways.nowEpochMilliseconds(),
                            context.req.raw.signal,
                        ),
                        202,
                    );
                }
                if (kind === "elicitation") {
                    assertExactKeys(body, ["action", "content", "kind", "responderId"]);
                    let command: SessionElicitationRespondCommand;
                    try {
                        command = decodeSessionElicitationRespondCommand(
                            JSON.stringify({
                                action: readString(body, "action", 32),
                                content: readString(body, "content", 100_000),
                                interactionId,
                                kind: SESSION_ELICITATION_RESPOND_KIND,
                                sessionId,
                            }),
                        );
                    } catch (cause) {
                        throw new PairingDirectoryError("invalid_request", "The elicitation response is invalid", {
                            cause,
                        });
                    }
                    return context.json(
                        await useCases.respondToElicitation(
                            projectId,
                            bearerToken(context.req.raw),
                            responderId,
                            command,
                            context.env.gateways.nowEpochMilliseconds(),
                            context.req.raw.signal,
                        ),
                        202,
                    );
                }
                throw new PairingDirectoryError("invalid_request", "The Interaction response kind is invalid");
            },
        )
        .get("/projects/:projectId/sessions/:sessionId/messages", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.readMessages(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    optionalCursor(context.req.query("cursor")),
                    pageLimit(context.req.query("limit")),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/projects/:projectId/sessions/:sessionId/events", async (context) => {
            const useCases = context.env.services.sessions;
            if (
                context.req
                    .header("accept")
                    ?.split(",")
                    .some((value) => value.trim().split(";", 1)[0] === "text/event-stream") === true
            ) {
                return await useCases.openEventStream(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    context.req.query("cursor") ?? "",
                    context.req.raw.signal,
                );
            }
            return context.json(
                await useCases.readEvents(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    optionalCursor(context.req.query("cursor")),
                    pageLimit(context.req.query("limit")),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/projects/:projectId/sessions/:sessionId/attempts/:attemptId/tool-calls/:toolCallId", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.readToolCallDetail(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    validateIdentifier(context.req.param("attemptId"), "attempt_id"),
                    validateIdentifier(context.req.param("toolCallId"), "tool_call_id"),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/projects/:projectId/sessions/:sessionId/native-history", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.readNativeHistory(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/projects/:projectId/sessions/:sessionId/export", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json({
                formatVersion: MOBIUS_SESSION_EXPORT_FORMAT_VERSION,
                session: await useCases.exportSession(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    context.req.raw.signal,
                ),
            });
        })
        .delete("/projects/:projectId/sessions/:sessionId", async (context) => {
            const useCases = context.env.services.sessions;
            return context.json(
                await useCases.deleteSession(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    context.env.gateways.nowEpochMilliseconds(),
                    context.req.raw.signal,
                ),
            );
        })
        .post(
            "/channels/:channelId/sessions/:sessionId/attempts/:attemptId/reconciliation",
            bodyParser<RelayHttpEnvironment>(["outcome"]),
            async (context) => {
                const useCases = context.env.services.sessions;
                const body = context.req.valid("json");
                return context.json(
                    await useCases.reconcileAttempt(
                        validateIdentifier(context.req.param("channelId"), "channel_id"),
                        context.req.query("token") ?? bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(context.req.param("attemptId"), "attempt_id"),
                        reconciliationOutcome(body),
                        context.env.gateways.nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                );
            },
        );
}
