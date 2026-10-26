import { createHash } from "node:crypto";
import { decodeAcpSessionUpdate, type SessionEventPayload } from "@moxt-ai/mobius-sdk/protocol";
import { revalidateExecutable, stopProcessTree } from "../../../util/process/executable.ts";
import { AcpExecutionError } from "../../acp-error.ts";
import type { AcpContentExternalizer } from "../../content/content-externalizer.ts";
import { CodexAppServerClient } from "../../harness/codex/app-server-client.ts";
import { replayCodexHistory } from "../../harness/codex/history.ts";
import type {
    Adapter,
    AdapterDependencies,
    NativeSessionLookupBudget,
    NativeSessionPreviewRequest,
    NativeSessionQuery,
    SessionEventPage,
} from "../../native-history/preview-contract.ts";
import { nativeSessionIdSchema } from "../../protocol/native-session.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { openPreviewEventCache, type PreviewEventCache } from "../preview-event-cache.ts";
import { AgentQueryProcesses } from "../query-processes.ts";
import { AcpSessionConnector, type AdapterSessionConnectionOptions } from "../session-events.ts";
import { fitCodexToolEvent, prepareCodexToolUpdate } from "./tool-event.ts";

/**
 * Previews saved Codex threads by reading the Codex app-server directly. The read is
 * short-lived and never resumes the source thread, so it needs no writer lock; ACP
 * `session/load` remains the fallback for resuming the conversation.
 */
export class CodexAdapter implements Adapter {
    readonly #queryProcesses: AgentQueryProcesses;
    readonly #connector: AcpSessionConnector;
    readonly #dependencies: AdapterDependencies;
    readonly #contentExternalizer: Pick<AcpContentExternalizer, "update">;
    #previewCache: PreviewEventCache | null = null;

    constructor(dependencies: AdapterDependencies) {
        this.#dependencies = dependencies;
        this.#contentExternalizer = {
            update: async (sessionId, update, signal) => {
                signal.throwIfAborted();
                const prepared = prepareCodexToolUpdate(update);
                signal.throwIfAborted();
                return await dependencies.contentExternalizer.update(sessionId, prepared, signal);
            },
        };
        this.#connector = new AcpSessionConnector(this.#contentExternalizer, fitCodexToolEvent);
        this.#queryProcesses = new AgentQueryProcesses(dependencies.processes, this.#connector);
    }

    readonly getCapabilities = async (query: NativeSessionQuery) => await this.#queryProcesses.capabilities(query);
    readonly connectSession = (options: AdapterSessionConnectionOptions) => this.#connector.connectSession(options);
    readonly listSessions = async (query: NativeSessionQuery, cursor: string | null) =>
        await this.#queryProcesses.listNativeSessions(query, cursor);
    readonly findSession = (query: NativeSessionQuery, nativeSessionId: string, budget: NativeSessionLookupBudget) =>
        findNativeSession(this.listSessions, query, nativeSessionId, budget);
    readonly close = async (): Promise<void> => {
        try {
            await this.#queryProcesses.close();
        } finally {
            this.#previewCache?.close();
        }
    };

    readonly readSessionHistory = async (
        query: NativeSessionQuery,
        request: NativeSessionPreviewRequest,
    ): Promise<SessionEventPage> => {
        const { agent, cwd } = query;
        const signal = AbortSignal.any([query.signal, AbortSignal.timeout(60_000)]);
        const { sessionId } = request;
        signal.throwIfAborted();
        nativeSessionIdSchema.parse(request.nativeSessionId);
        if (agent.id !== "codex") {
            throw new AcpExecutionError(
                "The Codex adapter cannot preview history for another agent.",
                {},
                "agent_adapter_mismatch",
            );
        }
        if (!(await revalidateExecutable(agent.agentIdentity))) {
            throw new AcpExecutionError(
                "The local Codex executable changed. Restart Mobius to discover it again.",
                {},
                "agent_executable_changed",
            );
        }
        this.#previewCache ??= openPreviewEventCache();
        const events: SessionEventPayload[] = [];
        await this.#dependencies.processes.runTransient(
            signal,
            async () => {
                const client = new CodexAppServerClient({
                    command: agent.command,
                    cwd,
                    environment: agent.environment,
                    handlers: {
                        onNotification: async () => undefined,
                        onServerRequest: async () => {
                            throw new AcpExecutionError(
                                "Unexpected request while reading saved history",
                                {},
                                "invalid_native_session_response",
                            );
                        },
                    },
                });
                return {
                    client,
                    closeProcess: async () => {
                        client.detach();
                        await stopProcessTree(client.child());
                    },
                };
            },
            async ({ client }) => {
                await client.initialize(signal);
                return await replayCodexHistory(
                    client,
                    request.nativeSessionId,
                    async (update) => {
                        const externalized = await this.#contentExternalizer.update(sessionId, update, signal);
                        events.push({
                            type: "acp",
                            payload: decodeAcpSessionUpdate(JSON.stringify(fitCodexToolEvent(externalized.event))),
                        });
                    },
                    signal,
                );
            },
            async (runtime) => await runtime.closeProcess(),
        );
        const generationId = createHash("sha256")
            .update(request.nativeSessionId)
            .update("\0")
            .update(JSON.stringify(events))
            .digest("hex");
        this.#previewCache.events.materialize(sessionId, generationId, events);
        return this.#previewCache.events.page(sessionId, request.eventLimit, request.cursor);
    };
}
