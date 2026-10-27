import {
    decodeSessionCancelBeforeStartCommand,
    decodeSessionCancelCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionHistoryPageLoad,
    decodeSessionPermissionRespondCommand,
    decodeSessionPromptDispositionCommand,
    type Identifier,
    isIdentifier,
} from "@moxt-ai/mobius-sdk/protocol";
import { type Context, Hono } from "hono";
import * as v from "valibot";
import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
import { bearerToken } from "../../infra/relay-http.ts";
import type { RuntimeControlCommand } from "../../service/pairing/runtime-control-request.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

const identifier = v.custom<Identifier>(isIdentifier);
const cancellation = v.strictObject({ idempotencyKey: identifier });
const disposition = v.strictObject({ disposition: v.literal("steer") });
const interactionResponse = v.variant("kind", [
    v.strictObject({
        kind: v.literal("permission"),
        optionId: v.pipe(v.string(), v.maxLength(255)),
        outcome: v.picklist(["cancelled", "selected"]),
        responderId: identifier,
    }),
    v.strictObject({
        action: v.picklist(["accept", "cancel", "decline"]),
        content: v.pipe(v.string(), v.maxLength(100_000)),
        kind: v.literal("elicitation"),
        responderId: identifier,
    }),
]);

function validated<TSchema extends v.GenericSchema>(schema: TSchema, value: unknown): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, value);
    if (!result.success) {
        throw new PairingDirectoryError("invalid_request", "The Runtime Session request is invalid", {
            cause: result.issues,
        });
    }
    return result.output;
}

async function requestControl(context: Context<RelayHttpEnvironment>, command: RuntimeControlCommand) {
    return await context.env.services.runtimePairings.requestControl(
        validated(identifier, context.req.param("projectId")),
        validated(identifier, context.req.param("runtimeId")),
        bearerToken(context.req.raw),
        command,
        context.req.raw.signal,
    );
}

export function createProjectRuntimeSessionControlRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .post(
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/turns/:turnId/cancel",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(cancellation, context.req.valid("json"));
                const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
                const turnId = validateIdentifier(context.req.param("turnId"), "turn_id");
                const completed = await requestControl(
                    context,
                    decodeSessionCancelCommand(
                        JSON.stringify({ commandId: turnId, kind: "session.cancel", sessionId }),
                    ),
                );
                if (completed.kind !== "turn.completed" || completed.commandId !== turnId) {
                    throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid cancellation");
                }
                const cancelledAt = new Date().toISOString();
                context.header("Cache-Control", "no-store");
                return context.json({
                    acceptedAt: cancelledAt,
                    bindingId: "workspace",
                    idempotencyKey: body.idempotencyKey,
                    request: { content: "", kind: "prompt", sessionConfigurations: [] },
                    sessionId,
                    state: { cancelledAt, kind: "cancelled" },
                    turnId,
                });
            },
        )
        .post(
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/turns/:turnId/cancel-before-start",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(cancellation, context.req.valid("json"));
                const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
                const turnId = validateIdentifier(context.req.param("turnId"), "turn_id");
                const completed = await requestControl(
                    context,
                    decodeSessionCancelBeforeStartCommand(
                        JSON.stringify({ commandId: turnId, kind: "session.cancel-before-start", sessionId }),
                    ),
                );
                if (completed.kind !== "turn.completed" || completed.commandId !== turnId) {
                    throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid cancellation");
                }
                context.header("Cache-Control", "no-store");
                return context.json({ turnId, idempotencyKey: body.idempotencyKey });
            },
        )
        .put(
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/turns/:turnId/disposition",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(disposition, context.req.valid("json"));
                const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
                const turnId = validateIdentifier(context.req.param("turnId"), "turn_id");
                const started = await requestControl(
                    context,
                    decodeSessionPromptDispositionCommand(
                        JSON.stringify({
                            commandId: turnId,
                            disposition: body.disposition,
                            kind: "session.prompt.disposition",
                            sessionId,
                        }),
                    ),
                );
                if (started.kind !== "turn.started" || started.commandId !== turnId) {
                    throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid steered Turn");
                }
                context.header("Cache-Control", "no-store");
                return context.json({ turnId });
            },
        )
        .post(
            "/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/interactions/:interactionId/responses",
            bodyParser<RelayHttpEnvironment>(),
            async (context) => {
                const body = validated(interactionResponse, context.req.valid("json"));
                const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
                const interactionId = validateIdentifier(context.req.param("interactionId"), "interaction_id");
                const command =
                    body.kind === "permission"
                        ? decodeSessionPermissionRespondCommand(
                              JSON.stringify({
                                  interactionId,
                                  kind: "session.permission.respond",
                                  optionId: body.optionId,
                                  outcome: body.outcome,
                                  sessionId,
                              }),
                          )
                        : decodeSessionElicitationRespondCommand(
                              JSON.stringify({
                                  action: body.action,
                                  content: body.content,
                                  interactionId,
                                  kind: "session.elicitation.respond",
                                  sessionId,
                              }),
                          );
                await requestControl(context, command);
                context.header("Cache-Control", "no-store");
                return context.json({ accepted: true });
            },
        )
        .get("/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/events-v2", async (context) => {
            const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
            const cursor = context.req.query("cursor");
            const omit = context.req.queries("omit");
            if (omit !== undefined) {
                validated(v.pipe(v.array(v.literal("agent-reasoning")), v.maxLength(1)), omit);
            }
            const result = await requestControl(
                context,
                decodeSessionHistoryPageLoad(
                    JSON.stringify({
                        cursor:
                            cursor === undefined
                                ? null
                                : validated(v.pipe(v.string(), v.minLength(1), v.maxLength(512)), cursor),
                        eventLimit: validated(
                            v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10_000)),
                            Number(context.req.query("limit") ?? "50"),
                        ),
                        kind: "session.live-history.v2.page.load",
                        requestId: crypto.randomUUID(),
                        sessionId,
                    }),
                ),
            );
            if (result.kind !== "session.live-history.v2.page.loaded") {
                throw new PairingDirectoryError("invalid_request", "The Runtime returned invalid V2 Session events");
            }
            context.header("Cache-Control", "no-store");
            return context.json(result.events.events);
        });
}
