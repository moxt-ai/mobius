import { AcpExecutionError } from "../../acp-error.ts";
import { readCodexFullHistory } from "../../native-history/codex/codex-history.ts";
import { nativeHistoryEvents } from "../../native-history/codex/native-history-events.ts";
import type {
    Adapter,
    AdapterDependencies,
    NativeSessionPreviewRequest,
    NativeSessionQuery,
    SessionEventPage,
} from "../../native-history/preview-contract.ts";
import { openPreviewEventCache, type PreviewEventCache } from "../preview-event-cache.ts";
import { AgentQueryProcesses } from "../query-processes.ts";
import { AcpSessionConnector, type AdapterSessionConnectionOptions } from "../session-events.ts";

/**
 * Previews saved Codex threads by reading the Codex app-server directly. The read is
 * short-lived and never resumes the source thread, so it needs no writer lock; ACP
 * `session/load` remains the fallback for resuming the conversation.
 */
export class CodexAdapter implements Adapter {
    readonly #queryProcesses: AgentQueryProcesses;
    readonly #connector: AcpSessionConnector;
    #previewCache: PreviewEventCache | null = null;

    constructor(dependencies: AdapterDependencies) {
        this.#connector = new AcpSessionConnector(dependencies.contentExternalizer);
        this.#queryProcesses = new AgentQueryProcesses(dependencies.processes, this.#connector);
    }

    readonly capabilities = async (query: NativeSessionQuery) => await this.#queryProcesses.capabilities(query);
    readonly connectSession = (options: AdapterSessionConnectionOptions) => this.#connector.connectSession(options);
    readonly listNativeSessions = async (query: NativeSessionQuery, cursor: string | null) =>
        await this.#queryProcesses.listNativeSessions(query, cursor);
    readonly close = async (): Promise<void> => {
        try {
            await this.#queryProcesses.close();
        } finally {
            this.#previewCache?.close();
        }
    };

    readonly previewSessionEvents = async (
        query: NativeSessionQuery,
        request: NativeSessionPreviewRequest,
    ): Promise<SessionEventPage> => {
        const { agent, cwd, signal } = query;
        const { sessionId } = request;
        this.#previewCache ??= openPreviewEventCache();
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
            this.#previewCache.events,
        );
    };
}
