import { AcpExecutionError } from "../../acp-error.ts";
import { AgentUpdateStream } from "../../connection/agent-update-stream.ts";
import type { AcpContentExternalizer, ExternalizeSessionUpdate } from "../../content/content-externalizer.ts";
import type { PiAcpClient } from "../../harness/pi/upstream/dist/acp/client.js";
import type { AdapterSessionCreateParams, NativeSessionQuery } from "../../native-history/preview-contract.ts";
import { type NativeSessionId, nativeSessionIdSchema } from "../../protocol/native-session.ts";
import {
    type NativeSessionEvent,
    type NativeSessionInteractions,
    nativeSessionEvent,
} from "../native-session-event.ts";

export function piSessionClientParams(params: AdapterSessionCreateParams, externalizer: AcpContentExternalizer) {
    return {
        scope: { cwd: params.scope.cwd, additionalDirectories: params.scope.additionalDirectories },
        signal: params.signal,
        callbacks: piClientCallbacks(
            {
                onSessionEvent: params.onSessionEvent,
                interactions: params.interactions,
                ...(params.scope.externalizeUpdate === undefined
                    ? {}
                    : { externalizeUpdate: params.scope.externalizeUpdate }),
            },
            externalizer,
        ),
    };
}

export function piQueryClientParams(
    query: NativeSessionQuery,
    externalizer: AcpContentExternalizer,
    onSessionEvent: (nativeSessionId: NativeSessionId, event: NativeSessionEvent) => Promise<void> = async () =>
        undefined,
) {
    const rejectInteraction = async (): Promise<never> => {
        throw new AcpExecutionError(
            "Read-only history previews cannot request user interaction",
            {},
            "native_session_interaction_unsupported",
        );
    };
    return {
        scope: { cwd: query.cwd, additionalDirectories: query.additionalDirectories },
        signal: query.signal,
        callbacks: piClientCallbacks(
            {
                onSessionEvent,
                ...(query.externalizeUpdate === undefined ? {} : { externalizeUpdate: query.externalizeUpdate }),
                interactions: { onPermission: rejectInteraction, onElicitation: rejectInteraction },
            },
            externalizer,
        ),
    };
}

/** Adapt Pi's existing host callback port; no runtime ownership or client lookup. */
export function piClientCallbacks(
    params: {
        readonly externalizeUpdate?: ExternalizeSessionUpdate;
        readonly onSessionEvent: (nativeSessionId: NativeSessionId, event: NativeSessionEvent) => Promise<void>;
        readonly interactions: Pick<NativeSessionInteractions, "onPermission" | "onElicitation">;
    },
    externalizer: Pick<AcpContentExternalizer, "update">,
): PiAcpClient {
    let lifetime: AbortSignal = new AbortController().signal;
    let message:
        | { readonly kind: "none" }
        | {
              readonly kind: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
              readonly messageId: string;
          } = { kind: "none" };
    const updates = new AgentUpdateStream(async (notification) => {
        lifetime.throwIfAborted();
        const nativeSessionId = nativeSessionIdSchema.parse(notification.sessionId);
        const signal = AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]);
        const externalized =
            params.externalizeUpdate === undefined
                ? await externalizer.update(nativeSessionId, notification.update, signal)
                : await params.externalizeUpdate(notification.update, signal);
        for (const event of externalized.events) {
            signal.throwIfAborted();
            await params.onSessionEvent(nativeSessionId, nativeSessionEvent(externalized.agent, event));
        }
    }, "identified");

    return {
        sessionUpdate: async (notification, signal) => {
            if (signal === undefined) {
                throw new AcpExecutionError("Pi did not supply its callback lifetime", {}, "invalid_agent_session");
            }
            lifetime = signal;
            if (lifetime.aborted) {
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
                    await updates.receive({ ...notification, update: { ...update, messageId: message.messageId } });
                    return;
                default:
                    message = { kind: "none" };
                    await updates.receive({ ...notification, update });
            }
        },
        startUserMessage: () => {
            message = { kind: "none" };
        },
        requestPermission: async (request) => {
            await updates.drained();
            return await params.interactions.onPermission(request, lifetime);
        },
        requestElicitation: async (request, signal) => {
            await updates.drained();
            return await params.interactions.onElicitation(request, AbortSignal.any([signal, lifetime]));
        },
    };
}
