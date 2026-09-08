import { Hono } from "hono";

import { validateIdentifier } from "../pairing-directory.ts";
import type { SessionUseCases } from "../relay-use-cases.ts";
import { CreateSessionBindingRequest } from "../session-runtime.ts";
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
} from "./relay-http.ts";

export function createSessionRoutes(useCases: SessionUseCases): Hono {
    const app = new Hono();

    app.post("/projects/:projectId/sessions", async (context) => {
        try {
            return context.json(
                await useCases.createSession(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    createRequest(await parseJsonBody(context.req.raw)),
                    Date.now(),
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
            assertExactKeys(body, ["export"]);
            return context.json(
                await useCases.importSession(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    body["export"],
                    Date.now(),
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
                    Date.now(),
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

    app.get("/projects/:projectId/sessions/:sessionId/attempts/:attemptId/tool-calls/:toolCallId", async (context) => {
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
    });

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
            return context.json(
                await useCases.exportSession(
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

    app.delete("/projects/:projectId/sessions/:sessionId", async (context) => {
        try {
            return context.json(
                await useCases.deleteSession(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearerToken(context.req.raw),
                    validateIdentifier(context.req.param("sessionId"), "session_id"),
                    Date.now(),
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
                    Date.now(),
                    context.req.raw.signal,
                ),
            );
        } catch (error) {
            preserveCancellation(context.req.raw.signal, error);
            return sessionError(error);
        }
    });

    return app;
}
