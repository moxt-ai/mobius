import type { AcpNativeEventReplay } from "../../../session/api/session-api.ts";
import { AcpExecutionError } from "../../acp-error.ts";
import { readCodexFullHistory } from "../../native-history/codex/codex-history.ts";
import { nativeHistoryEvents } from "../../native-history/codex/native-history-events.ts";
import type { Adapter, AdapterContext, NativeSessionPreviewRequest } from "../context.ts";

/**
 * Previews saved Codex threads by reading the Codex app-server directly. The read is
 * short-lived and never resumes the source thread, so it needs no writer lock; ACP
 * `session/load` remains the fallback for resuming the conversation.
 */
export class CodexAdapter implements Adapter {
    readonly previewSessionEvents = async (
        request: NativeSessionPreviewRequest,
        context: AdapterContext,
    ): Promise<AcpNativeEventReplay> => {
        const { agent, cwd, signal, sessionId } = context.options;
        const snapshot = await readCodexFullHistory(agent, cwd, request.nativeSessionId, signal);
        if (snapshot.history.status === "unavailable") {
            throw new AcpExecutionError(snapshot.history.cause.message, {}, snapshot.history.cause.code);
        }
        return nativeHistoryEvents(
            sessionId,
            request.nativeSessionId,
            snapshot.history,
            request.eventLimit,
            request.cursor,
            context.events,
        );
    };
}
