import {
    decodeNativeSessionRequest,
    decodeSessionCancelBeforeStartCommand,
    decodeSessionCancelCommand,
    decodeSessionConfigReadCommand,
    decodeSessionConfigureCommand,
    decodeSessionElicitationRespondCommand,
    decodeSessionHistoryPageLoad,
    decodeSessionPermissionRespondCommand,
    decodeSessionPreviewHistoryPageLoad,
    decodeSessionPromptCommand,
    decodeSessionPromptDispositionCommand,
    decodeSessionQueryCommand,
    decodeSessionRenameCommand,
    ProtocolMessageError,
    promptCompletion,
    RUNTIME_WORKSPACE_BINDING_ID,
    type SessionPromptCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { RuntimeControlCommand, RuntimeControlResult } from "./runtime-control-request.ts";

/** Runs one command on a Runtime the caller is already authorized to control, and returns the Runtime's answer. */
export type RuntimeControl = (command: RuntimeControlCommand) => Promise<RuntimeControlResult>;

/** The Agent and directories a Session runs in. */
export interface SessionExecutionIdentity {
    readonly agentId: string;
    readonly directoryId: string;
    readonly additionalDirectoryIds: readonly string[];
}

/**
 * A Session's binding as a caller states it for an operation on that existing Session. The Runtime owns the binding,
 * so each omitted field is the Session's own; each supplied field reaches the Runtime unchanged, which validates it.
 */
export interface SessionBindingRequest {
    readonly agentId?: string | undefined;
    readonly directoryId?: string | undefined;
    readonly additionalDirectoryIds?: readonly string[] | undefined;
}

export interface TurnSubmission extends SessionBindingRequest {
    readonly commandId: string;
    readonly content: string;
    readonly attachments: readonly unknown[];
    readonly disposition: string;
    readonly targetCommandId: string;
    readonly sessionConfigurations: readonly unknown[];
    readonly historyPolicy?: "eager" | "execution-only" | undefined;
}

export type InteractionResponse =
    | { readonly kind: "permission"; readonly optionId: string; readonly outcome: "cancelled" | "selected" }
    | { readonly kind: "elicitation"; readonly action: "accept" | "cancel" | "decline"; readonly content: string };

export interface SessionConfiguration extends SessionBindingRequest {
    readonly configId: string;
    readonly expectedConfigurationRevision: string;
    readonly valueType: "select" | "boolean";
    readonly value: string;
    readonly booleanValue: boolean;
}

/**
 * The operations every Session API offers on one Session. Each builds the Runtime command, runs it through the
 * caller's authorized control and checks that the answer belongs to that command. Routes authenticate, decode their
 * own request format and shape their own response; they do not repeat these rules.
 */
export class SessionControl {
    readonly #control: RuntimeControl;
    readonly #sessionId: string;

    constructor(control: RuntimeControl, sessionId: string) {
        this.#control = control;
        this.#sessionId = sessionId;
    }

    readonly submitTurn = async (
        turn: TurnSubmission,
    ): Promise<{ readonly commandId: string; readonly state: "running" | "queued" }> => {
        const binding = await this.#binding(turn);
        let command: SessionPromptCommand;
        try {
            command = decodeSessionPromptCommand(
                JSON.stringify({
                    additionalDirectoryIds: binding.additionalDirectoryIds,
                    agentId: binding.agentId,
                    attachments: turn.attachments,
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    commandId: turn.commandId,
                    directoryId: binding.directoryId,
                    disposition: turn.disposition,
                    ...(turn.historyPolicy === undefined ? {} : { historyPolicy: turn.historyPolicy }),
                    kind: "session.prompt",
                    prompt: turn.content,
                    sessionConfigurations: turn.sessionConfigurations,
                    sessionId: this.#sessionId,
                    targetCommandId: turn.targetCommandId,
                }),
            );
        } catch (error) {
            // The caller supplied this prompt, so protocol rejection is a client error, not a retryable outage.
            if (error instanceof ProtocolMessageError) {
                throw new PairingDirectoryError("invalid_request", "The Turn request is invalid", { cause: error });
            }
            throw error;
        }
        const result = await this.#control(command);
        if (
            (result.kind !== "turn.started" && result.kind !== "turn.queued") ||
            result.commandId !== command.commandId
        ) {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid Turn");
        }
        return { commandId: result.commandId, state: result.kind === "turn.queued" ? "queued" : "running" };
    };

    readonly cancelTurn = async (turnId: string): Promise<{ readonly stopReason: string }> => {
        const completed = await this.#control(
            decodeSessionCancelCommand(
                JSON.stringify({ commandId: turnId, kind: "session.cancel", sessionId: this.#sessionId }),
            ),
        );
        if (completed.kind !== "turn.completed" || completed.commandId !== turnId) {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid cancellation");
        }
        return { stopReason: completed.stopReason };
    };

    /** Withdraws a Turn that has not started; one that already started cannot be withdrawn. */
    readonly withdrawTurn = async (turnId: string): Promise<void> => {
        const completed = await this.#control(
            decodeSessionCancelBeforeStartCommand(
                JSON.stringify({ commandId: turnId, kind: "session.cancel-before-start", sessionId: this.#sessionId }),
            ),
        );
        if (completed.kind !== "turn.completed" || completed.commandId !== turnId) {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid cancellation");
        }
        if (promptCompletion(completed).kind !== "cancelled") {
            throw new PairingDirectoryError(
                "turn_already_started",
                "The message already executed and could not be withdrawn",
            );
        }
    };

    readonly steerTurn = async (turnId: string): Promise<void> => {
        const started = await this.#control(
            decodeSessionPromptDispositionCommand(
                JSON.stringify({
                    commandId: turnId,
                    disposition: "steer",
                    kind: "session.prompt.disposition",
                    sessionId: this.#sessionId,
                }),
            ),
        );
        if (started.kind !== "turn.started" || started.commandId !== turnId) {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid steered Turn");
        }
    };

    readonly respond = async (interactionId: string, response: InteractionResponse): Promise<void> => {
        await this.#control(
            response.kind === "permission"
                ? decodeSessionPermissionRespondCommand(
                      JSON.stringify({
                          interactionId,
                          kind: "session.permission.respond",
                          optionId: response.optionId,
                          outcome: response.outcome,
                          sessionId: this.#sessionId,
                      }),
                  )
                : decodeSessionElicitationRespondCommand(
                      JSON.stringify({
                          action: response.action,
                          content: response.content,
                          interactionId,
                          kind: "session.elicitation.respond",
                          sessionId: this.#sessionId,
                      }),
                  ),
        );
    };

    readonly readConfiguration = async () => {
        const result = await this.#control(
            decodeSessionConfigReadCommand(
                JSON.stringify({
                    kind: "session.config.read",
                    requestId: crypto.randomUUID(),
                    sessionId: this.#sessionId,
                }),
            ),
        );
        if (result.kind !== "session.config.read.result") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned invalid Session settings");
        }
        return result;
    };

    readonly configure = async (configuration: SessionConfiguration) =>
        await this.#control(
            decodeSessionConfigureCommand(
                JSON.stringify({
                    ...configuration,
                    ...(await this.#binding(configuration)),
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    kind: "session.configure",
                    requestId: crypto.randomUUID(),
                    sessionId: this.#sessionId,
                }),
            ),
        );

    readonly rename = async (title: string) =>
        await this.#control(
            decodeSessionRenameCommand(
                JSON.stringify({
                    kind: "session.rename",
                    requestId: crypto.randomUUID(),
                    sessionId: this.#sessionId,
                    title,
                }),
            ),
        );

    /** The Session's running Turn, and the delivery of `deliveryCommandId` when the caller names one. */
    readonly activeTurn = async (supplied: SessionBindingRequest, deliveryCommandId?: string) => {
        const identity = await this.#binding(supplied);
        const result = await this.#control(
            decodeNativeSessionRequest(
                JSON.stringify({
                    action: "active-turn",
                    additionalDirectoryIds: identity.additionalDirectoryIds,
                    agentId: identity.agentId,
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    ...(deliveryCommandId === undefined ? {} : { deliveryCommandId }),
                    directoryId: identity.directoryId,
                    kind: "native.session.request",
                    requestId: crypto.randomUUID(),
                    sessionId: this.#sessionId,
                    targetSessionId: this.#sessionId,
                }),
            ),
        );
        if (result.kind !== "native.session.result" || result.action !== "active-turn") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid active Turn");
        }
        return result;
    };

    /** A page of the Agent's native history for the Session, as Session events. */
    readonly previewEvents = async (
        supplied: SessionBindingRequest,
        page: { readonly cursor: string | null; readonly eventLimit: number },
    ) => {
        const identity = await this.#binding(supplied);
        const result = await this.#control(
            decodeSessionPreviewHistoryPageLoad(
                JSON.stringify({
                    additionalDirectoryIds: identity.additionalDirectoryIds,
                    agentId: identity.agentId,
                    bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                    cursor: page.cursor,
                    directoryId: identity.directoryId,
                    eventLimit: page.eventLimit,
                    kind: "session.preview-history.page.load",
                    requestId: crypto.randomUUID(),
                    sessionId: this.#sessionId,
                }),
            ),
        );
        if (result.kind !== "session.preview-history.page.loaded") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned invalid V2 Session events");
        }
        return result.events;
    };

    /** A page of the Session's live history. */
    readonly liveEvents = async (page: { readonly cursor: string | null; readonly eventLimit: number }) => {
        const result = await this.#control(
            decodeSessionHistoryPageLoad(
                JSON.stringify({
                    cursor: page.cursor,
                    eventLimit: page.eventLimit,
                    kind: "session.live-history.v2.page.load",
                    requestId: crypto.randomUUID(),
                    sessionId: this.#sessionId,
                }),
            ),
        );
        if (result.kind !== "session.live-history.v2.page.loaded") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned invalid V2 Session events");
        }
        return result.events.events;
    };

    /** The binding an operation runs with: the caller's fields, and the Session's own from its Runtime for the rest. */
    readonly #binding = async (supplied: SessionBindingRequest): Promise<SessionExecutionIdentity> => {
        const { additionalDirectoryIds, agentId, directoryId } = supplied;
        if (agentId !== undefined && directoryId !== undefined && additionalDirectoryIds !== undefined) {
            return { additionalDirectoryIds, agentId, directoryId };
        }
        const queried = await this.#control(
            decodeSessionQueryCommand(
                JSON.stringify({
                    kind: "session.query",
                    requestId: crypto.randomUUID(),
                    sessionIds: [this.#sessionId],
                }),
            ),
        );
        if (queried.kind !== "session.queried") {
            throw new PairingDirectoryError("invalid_request", "The Runtime returned an invalid Session query");
        }
        const session = queried.entries.find((entry) => entry.sessionId === this.#sessionId);
        if (session === undefined) {
            throw new PairingDirectoryError("session_not_found", "The selected Session is unavailable");
        }
        return {
            additionalDirectoryIds:
                additionalDirectoryIds ?? session.additionalDirectories.map((directory) => directory.directoryId),
            agentId: agentId ?? session.agentId,
            directoryId: directoryId ?? session.directoryId,
        };
    };
}
