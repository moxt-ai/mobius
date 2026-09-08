import {
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeSessionElicitationRespondCommand,
    decodeSessionPermissionRespondCommand,
    MOBIUS_SESSION_EXPORT_FORMAT_VERSION,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_PERMISSION_RESPOND_KIND,
    type SessionElicitationRespondCommand,
    type SessionPermissionRespondCommand,
} from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";

import { RequestBodyError, readBoundedBytesBody } from "../../infra/bounded-request-body.ts";
import {
    assertExactKeys,
    bearerToken,
    createRequest,
    MAX_IMPORT_BODY_LENGTH,
    optionalCursor,
    pageLimit,
    parseJsonBody,
    preserveCancellation,
    readInteger,
    readString,
    reconciliationOutcome,
    sessionError,
} from "../../infra/relay-http.ts";
import {
    MAX_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    MIN_BROWSER_CREDENTIAL_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    validateIdentifier,
} from "../../service/pairing/pairing.ts";
import {
    CreateArtifactUploadRequest,
    CreateSessionBindingRequest,
    SessionRuntimeError,
} from "../../service/session/session.ts";
import { isRecord } from "../../service/session/session-codec.ts";
import type { SessionService } from "../../service/session/session-service.ts";

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

export class SessionController {
    static readonly inject = ["sessions", "nowEpochMilliseconds"] satisfies readonly [
        "sessions",
        "nowEpochMilliseconds",
    ];
    readonly routes: Hono;
    constructor(useCases: SessionService, nowEpochMilliseconds: () => number) {
        const app = new Hono();

        app.get("/projects/:projectId/runtimes", async (context) => {
            try {
                return context.json({
                    runtimes: await useCases.listRuntimes(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        context.req.raw.signal,
                    ),
                });
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.post("/projects/:projectId/browser-credentials", async (context) => {
            try {
                const body = await parseJsonBody(context.req.raw);
                assertExactKeys(body, ["expiresInSeconds"]);
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
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.delete("/projects/:projectId/browser-credentials/:credentialId", async (context) => {
            try {
                await useCases.revokeBrowserCredential(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("credentialId"), "credential_id"),
                    bearerToken(context.req.raw),
                    context.req.raw.signal,
                );
                return new Response(null, { status: 204 });
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.post("/projects/:projectId/sessions", async (context) => {
            try {
                return context.json(
                    await useCases.createSession(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        createRequest(await parseJsonBody(context.req.raw)),
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                    201,
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions", async (context) => {
            try {
                return context.json(
                    await useCases.listSessions(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        optionalCursor(context.req.query("cursor")),
                        pageLimit(context.req.query("limit")),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.post("/projects/:projectId/session-imports", async (context) => {
            try {
                const body = await parseJsonBody(context.req.raw, MAX_IMPORT_BODY_LENGTH);
                assertExactKeys(body, ["formatVersion", "session", "targetBinding"]);
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
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                    201,
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId", async (context) => {
            try {
                return context.json(
                    await useCases.readSession(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.put("/projects/:projectId/sessions/:sessionId/binding", async (context) => {
            try {
                const body = await parseJsonBody(context.req.raw);
                assertExactKeys(body, ["agentRef", "bindingId", "configRevision", "runtimeId", "workspaceRef"]);
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
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId/turns/:turnId", async (context) => {
            try {
                return context.json(
                    await useCases.readTurn(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(context.req.param("turnId"), "turn_id"),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.post("/projects/:projectId/sessions/:sessionId/turns", async (context) => {
            try {
                const body = await parseJsonBody(context.req.raw);
                assertExactKeys(body, [
                    "additionalDirectoryIds",
                    "artifactIds",
                    "content",
                    "idempotencyKey",
                    "images",
                    "resources",
                ]);
                const additionalDirectoryIds = readIdentifierArray(body, "additionalDirectoryIds", 16, "directory_id");
                const artifactIds = readIdentifierArray(body, "artifactIds", 16, "artifact_id");
                return context.json(
                    await useCases.submitTurn(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(readString(body, "idempotencyKey"), "idempotency_key"),
                        readString(body, "content", 100_000, true),
                        additionalDirectoryIds,
                        decodePromptImagesValue(body["images"]),
                        decodePromptResourcesValue(body["resources"]),
                        artifactIds,
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                    202,
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.post("/projects/:projectId/sessions/:sessionId/artifacts/uploads", async (context) => {
            try {
                const body = await parseJsonBody(context.req.raw);
                assertExactKeys(body, ["byteLength", "mediaType", "name", "sha256"]);
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
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                    201,
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.put("/projects/:projectId/sessions/:sessionId/artifacts/:artifactId/content", async (context) => {
            try {
                const projectId = validateIdentifier(context.req.param("projectId"), "project_id");
                const lease = await useCases.authorizeArtifactUpload(
                    projectId,
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                    context.req.header("x-mobius-upload-token") ?? "",
                    nowEpochMilliseconds(),
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
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId/artifacts/:artifactId", async (context) => {
            try {
                return context.json(
                    await useCases.readArtifact(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId/artifacts/:artifactId/content", async (context) => {
            try {
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
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.post("/projects/:projectId/sessions/:sessionId/turns/:turnId/cancel", async (context) => {
            try {
                const body = await parseJsonBody(context.req.raw);
                assertExactKeys(body, ["idempotencyKey"]);
                return context.json(
                    await useCases.cancelTurn(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(context.req.param("turnId"), "turn_id"),
                        validateIdentifier(readString(body, "idempotencyKey"), "idempotency_key"),
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                    202,
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId/attempts/:attemptId", async (context) => {
            try {
                return context.json(
                    await useCases.readAttempt(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(context.req.param("attemptId"), "attempt_id"),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId/interactions", async (context) => {
            try {
                return context.json({
                    interactions: await useCases.readPendingInteractions(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        context.req.raw.signal,
                    ),
                });
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId/interactions/:interactionId", async (context) => {
            try {
                return context.json(
                    await useCases.readInteraction(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(context.req.param("interactionId"), "interaction_id"),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.post("/projects/:projectId/sessions/:sessionId/interactions/:interactionId/responses", async (context) => {
            try {
                const body = await parseJsonBody(context.req.raw);
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
                            nowEpochMilliseconds(),
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
                            nowEpochMilliseconds(),
                            context.req.raw.signal,
                        ),
                        202,
                    );
                }
                throw new PairingDirectoryError("invalid_request", "The Interaction response kind is invalid");
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId/messages", async (context) => {
            try {
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
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId/events", async (context) => {
            try {
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
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get(
            "/projects/:projectId/sessions/:sessionId/attempts/:attemptId/tool-calls/:toolCallId",
            async (context) => {
                try {
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
                } catch (error) {
                    preserveCancellation(context.req.raw.signal, error);
                    return sessionError(error);
                }
            },
        );

        app.get("/projects/:projectId/sessions/:sessionId/native-history", async (context) => {
            try {
                return context.json(
                    await useCases.readNativeHistory(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.get("/projects/:projectId/sessions/:sessionId/export", async (context) => {
            try {
                return context.json({
                    formatVersion: MOBIUS_SESSION_EXPORT_FORMAT_VERSION,
                    session: await useCases.exportSession(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        context.req.raw.signal,
                    ),
                });
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.delete("/projects/:projectId/sessions/:sessionId", async (context) => {
            try {
                return context.json(
                    await useCases.deleteSession(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        app.post("/channels/:channelId/sessions/:sessionId/attempts/:attemptId/reconciliation", async (context) => {
            try {
                const body = await parseJsonBody(context.req.raw);
                assertExactKeys(body, ["outcome"]);
                return context.json(
                    await useCases.reconcileAttempt(
                        validateIdentifier(context.req.param("channelId"), "channel_id"),
                        context.req.query("token") ?? bearerToken(context.req.raw),
                        validateIdentifier(context.req.param("sessionId"), "session_id"),
                        validateIdentifier(context.req.param("attemptId"), "attempt_id"),
                        reconciliationOutcome(body),
                        nowEpochMilliseconds(),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        });

        this.routes = app;
    }
}
