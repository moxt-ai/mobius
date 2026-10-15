import { AcpExecutionError } from "../acp/acp-error.ts";
import { AgentSession } from "../acp/agent-session.ts";
import { isNativeChatSessionId } from "../native-sessions/chat-agent.ts";
import type { AdapterEventCache } from "./adapter-event-cache.ts";
import type { HarnessCreateSessionRequest, HarnessOpenSessionRequest, OpenedSession } from "./harness-adapter.ts";

export const openAcpSession = async (
    events: AdapterEventCache,
    request: HarnessOpenSessionRequest,
): Promise<OpenedSession> => {
    const openedEvents = events.openSessionEvents(request.options.sessionId);
    try {
        if (request.kind === "native-browser") {
            return await AgentSession.startNativeSessionBrowser(
                request.options,
                request.getObserver,
                request.store,
                openedEvents,
                request.contentExternalizer,
            );
        }
        return await AgentSession.start(
            request.options,
            request.recovery,
            request.getObserver,
            request.store,
            openedEvents,
            request.metrics,
            request.contentExternalizer,
        );
    } catch (error) {
        openedEvents.close();
        throw error;
    }
};

export const createAcpSession = async (
    adapterId: string,
    events: AdapterEventCache,
    request: HarnessCreateSessionRequest,
): Promise<OpenedSession> => {
    const temporarySessionId = `new-${crypto.randomUUID()}`;
    try {
        const session = await AgentSession.create(
            { ...request.options, sessionId: temporarySessionId },
            request.getObserver,
            request.store,
            request.metrics,
            request.contentExternalizer,
        );
        try {
            const nativeSessionId = session.nativeSessionId();
            if (!isNativeChatSessionId(adapterId, nativeSessionId)) {
                throw new AcpExecutionError(
                    "The Agent returned an invalid new Session ID",
                    {},
                    "invalid_native_session_response",
                );
            }
            request.authorizeNativeSessionId(nativeSessionId);
            const openedEvents = events.createSessionEvents(nativeSessionId);
            try {
                session.finishCreation(nativeSessionId, openedEvents);
            } catch (error) {
                openedEvents.close();
                throw error;
            }
            return session;
        } catch (error) {
            await session.closeProcess();
            throw error;
        }
    } finally {
        request.store.remove(temporarySessionId);
    }
};
