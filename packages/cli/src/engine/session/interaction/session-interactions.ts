import type {
    CompleteElicitationNotification,
    CreateElicitationRequest,
    CreateElicitationResponse,
    RequestPermissionRequest,
    RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    type SessionElicitationRequestedEvent,
    type SessionElicitationResolvedEvent,
    type SessionEventPayload,
    type SessionPermissionOption,
    type SessionPermissionRequestedEvent,
    type SessionPermissionResolvedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import { normalizeElicitationFields, validateElicitationContent } from "../../acp/protocol/elicitation.ts";
import type { ProjectedToolCall } from "../../acp/tool-call-projection.ts";

import { readString, truncate } from "../../util/value-utils.ts";
import type { ElicitationResponseOptions, PermissionResponseOptions, SessionObserver } from "../api/session-api.ts";
import { PendingElicitation, PendingPermission } from "./pending-interactions.ts";

interface SessionInteractionContext {
    readonly sessionId: () => string;
    readonly cwd: () => string;
    /**
     * The tool call the event history projection holds for this identifier,
     * with the announcements of the current turn already merged. A permission
     * request is a partial ToolCallUpdate, so fields it omits are read from
     * this announcement.
     */
    readonly getToolCall: (toolCallId: string) => ProjectedToolCall | undefined;
    readonly commandId: () => string;
    /**
     * Whether the Turn a request was asked under has ended, so nobody waits on the request any more.
     * A request asked while no Turn runs belongs to no Turn and never ends this way.
     */
    readonly turnEnded: (commandId: string) => boolean;
    readonly assertNativeSession: (sessionId: string) => void;
    readonly observer: () => SessionObserver;
    readonly recordSessionEvent: (event: SessionEventPayload) => Promise<void>;
}
type AnnouncedRequest = SessionPermissionRequestedEvent | SessionElicitationRequestedEvent;

export class SessionInteractions {
    readonly #pendingPermissions = new Map<string, PendingPermission>();
    readonly #pendingElicitations = new Map<string, PendingElicitation>();
    readonly #acceptedUrlElicitations = new Map<string, string>();
    /**
     * The requests still waiting for an answer, as announced and in the order they were asked. A live
     * event has no delivery acknowledgement, so the connection that carried an announcement can fail
     * right after sending it. The Runtime owns what its Agent waits on, so it announces this again.
     */
    readonly #announced = new Map<string, AnnouncedRequest>();
    readonly #context: SessionInteractionContext;
    constructor(context: SessionInteractionContext) {
        this.#context = context;
    }
    /** A request that is answered, cancelled or abandoned no longer waits, so it is no longer announced. */
    readonly #closePermission = (interactionId: string): void => {
        this.#pendingPermissions.delete(interactionId);
        this.#announced.delete(interactionId);
    };
    readonly #closeElicitation = (interactionId: string): void => {
        this.#pendingElicitations.delete(interactionId);
        this.#announced.delete(interactionId);
    };
    readonly #recordRequested = async (request: AnnouncedRequest): Promise<void> => {
        await this.#context.recordSessionEvent(
            request.kind === SESSION_PERMISSION_REQUESTED_KIND
                ? { payload: { event: request, kind: "session.permission.requested" }, type: "lifecycle-metadata" }
                : { payload: { event: request, kind: "session.elicitation.requested" }, type: "lifecycle-metadata" },
        );
    };
    readonly #notifyPermissionRequested = async (event: SessionPermissionRequestedEvent): Promise<void> => {
        await this.#recordRequested(event);
        await this.#context.observer().onPermission(event);
    };
    readonly #notifyPermissionResolved = async (event: SessionPermissionResolvedEvent): Promise<void> => {
        await this.#context.recordSessionEvent({
            payload: { event, kind: "session.permission.resolved" },
            type: "lifecycle-metadata",
        });
        await this.#context.observer().onPermissionResolved(event);
    };
    readonly #notifyElicitationRequested = async (event: SessionElicitationRequestedEvent): Promise<void> => {
        await this.#recordRequested(event);
        await this.#context.observer().onElicitation(event);
    };
    readonly #notifyElicitationResolved = async (event: SessionElicitationResolvedEvent): Promise<void> => {
        await this.#context.recordSessionEvent({
            payload: { event, kind: "session.elicitation.resolved" },
            type: "lifecycle-metadata",
        });
        await this.#context.observer().onElicitationResolved(event);
    };
    readonly respondPermission = async (options: PermissionResponseOptions): Promise<void> => {
        const pending = this.#pendingPermissions.get(options.interactionId);
        if (pending === undefined) {
            throw new AcpExecutionError(
                "The permission request is no longer active",
                {},
                "permission_request_not_found",
            );
        }
        if (options.outcome === "selected" && !pending.optionIds.has(options.optionId)) {
            throw new AcpExecutionError(
                "The selected permission option is unavailable",
                {},
                "invalid_permission_response",
            );
        }
        const resolved = options.outcome === "selected" ? pending.select(options.optionId) : pending.cancel();
        if (!resolved) {
            throw new AcpExecutionError(
                "The permission request was already resolved",
                {},
                "permission_request_not_found",
            );
        }
        this.#closePermission(options.interactionId);
        await this.#notifyPermissionResolved({
            interactionId: options.interactionId,
            kind: SESSION_PERMISSION_RESOLVED_KIND,
            optionId: options.outcome === "selected" ? options.optionId : "",
            outcome: options.outcome,
            sessionId: this.#context.sessionId(),
        });
    };

    readonly respondElicitation = async (options: ElicitationResponseOptions): Promise<void> => {
        const pending = this.#pendingElicitations.get(options.interactionId);
        if (pending === undefined) {
            throw new AcpExecutionError(
                "The elicitation request is no longer active",
                {},
                "elicitation_request_not_found",
            );
        }
        let resolved = false;
        if (options.action === "accept") {
            if (pending.elicitationId.length > 0) {
                resolved = pending.accept({});
                if (resolved) {
                    this.#acceptedUrlElicitations.set(pending.elicitationId, pending.interactionId);
                }
            } else {
                resolved = pending.accept(validateElicitationContent(options.content, pending.requestedSchema));
            }
        } else if (options.action === "decline") {
            resolved = pending.decline();
        } else {
            resolved = pending.cancel();
        }
        if (!resolved) {
            throw new AcpExecutionError(
                "The elicitation request was already resolved",
                {},
                "elicitation_request_not_found",
            );
        }
        this.#closeElicitation(options.interactionId);
        await this.#notifyElicitationResolved({
            action: options.action,
            interactionId: options.interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            sessionId: this.#context.sessionId(),
        });
    };

    readonly onPermission = async (
        request: RequestPermissionRequest,
        signal: AbortSignal,
    ): Promise<RequestPermissionResponse> => {
        this.#context.assertNativeSession(request.sessionId);
        const interactionId = `permission-${crypto.randomUUID()}`;
        const options: SessionPermissionOption[] = request.options.slice(0, 20).map((option) => ({
            kind: option.kind,
            name: truncate(option.name, 255),
            optionId: truncate(option.optionId, 255),
        }));
        if (options.length === 0) {
            throw new AcpExecutionError(
                "ACP permission request did not provide any choices",
                {},
                "invalid_agent_permission_request",
            );
        }
        const pending = new PendingPermission(interactionId, new Set(options.map((option) => option.optionId)));
        this.#pendingPermissions.set(interactionId, pending);
        const abort = (): void => {
            void this.cancelPermission(interactionId);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            // A permission request is a partial ToolCallUpdate: a field it
            // omits keeps the value announced for the same tool call, which
            // the event history projection holds in merged form.
            const announced = this.#context.getToolCall(request.toolCall.toolCallId);
            const title = request.toolCall.title ?? announced?.title;
            const kind = request.toolCall.kind ?? announced?.kind;
            const rawInput = request.toolCall.rawInput ?? announced?.rawInput;
            const locations = request.toolCall.locations ?? announced?.locations ?? [];
            const requested: SessionPermissionRequestedEvent = {
                commandId: this.#context.commandId(),
                details: {
                    cwd: this.#context.cwd(),
                    rawInput,
                    locations,
                },
                interactionId,
                kind: SESSION_PERMISSION_REQUESTED_KIND,
                options,
                sessionId: this.#context.sessionId(),
                title: truncate(title ?? "Permission required", 500),
                toolCallId: truncate(request.toolCall.toolCallId, 255),
                toolKind: truncate(kind ?? "other", 64),
            };
            this.#announced.set(interactionId, requested);
            await this.#notifyPermissionRequested(requested);
            return await pending.completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#closePermission(interactionId);
        }
    };

    readonly onElicitation = async (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => {
        const sessionId = Reflect.get(request, "sessionId");
        if (typeof sessionId !== "string") {
            throw new AcpExecutionError(
                "Mobius only accepts session-scoped ACP elicitations",
                {},
                "unsupported_elicitation_scope",
            );
        }
        this.#context.assertNativeSession(sessionId);
        if (request.mode !== "form" && request.mode !== "url") {
            throw new AcpExecutionError(
                "The ACP agent requested an unsupported elicitation mode",
                {},
                "unsupported_elicitation_mode",
            );
        }
        const interactionId = `elicitation-${crypto.randomUUID()}`;
        const schemaValue = Reflect.get(request, "requestedSchema");
        const requestedSchema = request.mode === "form" ? schemaValue : {};
        const elicitationIdValue = Reflect.get(request, "elicitationId");
        const elicitationId =
            request.mode === "url" && typeof elicitationIdValue === "string" ? truncate(elicitationIdValue, 255) : "";
        const pending = new PendingElicitation(interactionId, elicitationId, requestedSchema);
        this.#pendingElicitations.set(interactionId, pending);
        const abort = (): void => {
            void this.cancelElicitation(interactionId);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            const requested: SessionElicitationRequestedEvent = {
                accepted: false,
                commandId: this.#context.commandId(),
                elicitationId,
                fields: normalizeElicitationFields(requestedSchema),
                interactionId,
                kind: SESSION_ELICITATION_REQUESTED_KIND,
                message: truncate(request.message, 2_000),
                mode: request.mode,
                sessionId: this.#context.sessionId(),
                url:
                    request.mode === "url" && typeof Reflect.get(request, "url") === "string"
                        ? truncate(readString(Reflect.get(request, "url")), 4_096)
                        : "",
            };
            this.#announced.set(interactionId, requested);
            await this.#notifyElicitationRequested(requested);
            return await pending.completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#closeElicitation(interactionId);
        }
    };

    readonly onElicitationComplete = async (notification: CompleteElicitationNotification): Promise<void> => {
        const interactionId = this.#acceptedUrlElicitations.get(notification.elicitationId);
        if (interactionId === undefined) {
            return;
        }
        this.#acceptedUrlElicitations.delete(notification.elicitationId);
        await this.#notifyElicitationResolved({
            action: "complete",
            interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            sessionId: this.#context.sessionId(),
        });
    };

    readonly cancelPermission = async (interactionId: string): Promise<void> => {
        const pending = this.#pendingPermissions.get(interactionId);
        if (pending === undefined || !pending.cancel()) {
            return;
        }
        this.#closePermission(interactionId);
        await this.#notifyPermissionResolved({
            interactionId,
            kind: SESSION_PERMISSION_RESOLVED_KIND,
            optionId: "",
            outcome: "cancelled",
            sessionId: this.#context.sessionId(),
        });
    };

    readonly cancelElicitation = async (interactionId: string): Promise<void> => {
        const pending = this.#pendingElicitations.get(interactionId);
        if (pending === undefined || !pending.cancel()) {
            return;
        }
        this.#closeElicitation(interactionId);
        await this.#notifyElicitationResolved({
            action: "cancel",
            interactionId,
            kind: SESSION_ELICITATION_RESOLVED_KIND,
            sessionId: this.#context.sessionId(),
        });
    };

    readonly cancelPendingInteractions = async (): Promise<void> => {
        const permissionIds = [...this.#pendingPermissions.keys()];
        const elicitationIds = [...this.#pendingElicitations.keys()];
        const acceptedElicitationIds = [...this.#acceptedUrlElicitations.values()];
        this.#acceptedUrlElicitations.clear();
        for (const interactionId of permissionIds) {
            await this.cancelPermission(interactionId);
        }
        for (const interactionId of elicitationIds) {
            await this.cancelElicitation(interactionId);
        }
        for (const interactionId of acceptedElicitationIds) {
            await this.#notifyElicitationResolved({
                action: "cancel",
                interactionId,
                kind: SESSION_ELICITATION_RESOLVED_KIND,
                sessionId: this.#context.sessionId(),
            });
        }
    };

    /**
     * Announces every request still waiting for an answer once more, in the order they were asked,
     * with the identity and content they were first announced with. The Recording and clients treat a
     * repeat as the request they already know, and a request that was lost with its connection becomes
     * visible again. Only requests that are still waiting are announced, so an answered one never
     * reopens, and a request of a Turn that has ended is not, because the Recording closed it with the
     * Turn.
     */
    readonly republishPending = async (): Promise<void> => {
        for (const [interactionId, request] of [...this.#announced]) {
            // An answer that arrives while an earlier request is announced settles this one as well.
            if (this.#announced.get(interactionId) === request && !this.#context.turnEnded(request.commandId)) {
                await this.#recordRequested(request);
            }
        }
    };
}
