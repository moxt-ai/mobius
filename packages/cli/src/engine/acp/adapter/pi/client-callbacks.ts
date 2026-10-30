import { AcpExecutionError } from "../../acp-error.ts";
import { AgentUpdateStream } from "../../connection/agent-update-stream.ts";
import type { AcpContentExternalizer, ExternalizeSessionUpdate } from "../../content/content-externalizer.ts";
import type { PiAcpClient } from "../../harness/pi/upstream/dist/acp/client.js";
import type { NativeSessionQuery } from "../../native-history/preview-contract.ts";
import { nativeSessionIdSchema } from "../../protocol/native-session.ts";
import {
    type NativeSessionEvent,
    type NativeSessionInteractions,
    type NativeSessionSubscriber,
    nativeSessionEvent,
} from "../native-session-event.ts";

/** The callback side of one Pi client; `fail` makes the owning session unavailable. */
export interface PiCallbackLifetime {
    readonly signal: AbortSignal;
    readonly fail: (cause: unknown) => void;
}

export interface PiCallbackParams {
    readonly externalizeUpdate?: ExternalizeSessionUpdate;
    readonly onSessionEvent: (nativeSessionId: string, event: NativeSessionEvent) => Promise<void>;
    readonly interactions: Pick<NativeSessionInteractions, "onPermission" | "onElicitation">;
}

export function piSessionCallbacks(
    subscriber: NativeSessionSubscriber,
    externalizeUpdate: ExternalizeSessionUpdate | undefined,
): PiCallbackParams {
    return {
        onSessionEvent: subscriber.onSessionEvent,
        interactions: subscriber.interactions,
        ...(externalizeUpdate === undefined ? {} : { externalizeUpdate }),
    };
}

/** Read-only previews replay history and must never prompt the user. */
export function piPreviewCallbacks(
    query: NativeSessionQuery,
    onSessionEvent: (nativeSessionId: string, event: NativeSessionEvent) => Promise<void>,
): PiCallbackParams {
    const rejectInteraction = async (): Promise<never> => {
        throw new AcpExecutionError(
            "Read-only history previews cannot request user interaction",
            {},
            "native_session_interaction_unsupported",
        );
    };
    return {
        onSessionEvent,
        interactions: { onPermission: rejectInteraction, onElicitation: rejectInteraction },
        ...(query.externalizeUpdate === undefined ? {} : { externalizeUpdate: query.externalizeUpdate }),
    };
}

/**
 * Adapt Pi's host callback port; no runtime ownership or client lookup. `drained` settles once
 * every received notification has been delivered, and rejects with the first delivery failure.
 */
export function piClientCallbacks(
    params: PiCallbackParams,
    externalizer: Pick<AcpContentExternalizer, "update">,
    lifetime: PiCallbackLifetime,
): PiAcpClient & { readonly drained: () => Promise<void> } {
    let message:
        | { readonly kind: "none" }
        | {
              readonly kind: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
              readonly messageId: string;
          } = { kind: "none" };
    const updates = new AgentUpdateStream(async (notification) => {
        lifetime.signal.throwIfAborted();
        const nativeSessionId = nativeSessionIdSchema.parse(notification.sessionId);
        const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
        const externalized =
            params.externalizeUpdate === undefined
                ? await externalizer.update(nativeSessionId, notification.update, signal)
                : await params.externalizeUpdate(notification.update, signal);
        for (const event of externalized.events) {
            signal.throwIfAborted();
            await params.onSessionEvent(nativeSessionId, nativeSessionEvent(externalized.agent, event));
        }
    }, "identified");
    const receive = async (notification: Parameters<AgentUpdateStream["receive"]>[0]): Promise<void> => {
        try {
            await updates.receive(notification);
        } catch (cause) {
            lifetime.fail(cause);
            throw cause;
        }
    };

    return {
        sessionUpdate: async (notification) => {
            if (lifetime.signal.aborted) {
                return;
            }
            const update = notification.update;
            switch (update.sessionUpdate) {
                case "user_message_chunk":
                case "agent_message_chunk":
                case "agent_thought_chunk":
                    if (message.kind !== update.sessionUpdate) {
                        message = { kind: update.sessionUpdate, messageId: crypto.randomUUID() };
                    }
                    await receive({ ...notification, update: { ...update, messageId: message.messageId } });
                    return;
                default:
                    message = { kind: "none" };
                    await receive({ ...notification, update });
            }
        },
        drained: () => updates.drained(),
        startUserMessage: () => {
            message = { kind: "none" };
        },
        requestPermission: async (request) => {
            await updates.drained();
            return await params.interactions.onPermission(request, lifetime.signal);
        },
        requestElicitation: async (request, signal) => {
            await updates.drained();
            return await params.interactions.onElicitation(request, AbortSignal.any([signal, lifetime.signal]));
        },
    };
}
