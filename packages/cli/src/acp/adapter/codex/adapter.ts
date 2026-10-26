import { createHash } from "node:crypto";
import {
    decodeAcpSessionUpdate,
    SESSION_HISTORY_CHARACTER_LIMIT,
    SESSION_HISTORY_MESSAGE_LIMIT,
    type SessionEventPayload,
} from "@moxt-ai/mobius-sdk/protocol";
import { revalidateExecutable, stopProcessTree } from "../../../util/process/executable.ts";
import { AcpExecutionError } from "../../acp-error.ts";
import { CodexAppServerClient } from "../../harness/codex/app-server-client.ts";
import { replayCodexHistory } from "../../harness/codex/history.ts";
import type {
    Adapter,
    AdapterDependencies,
    NativeSessionPreviewRequest,
    NativeSessionQuery,
    SessionEventPage,
} from "../../native-history/preview-contract.ts";
import { nativeSessionIdSchema } from "../../protocol/native-session.ts";
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
    readonly #dependencies: AdapterDependencies;
    #previewCache: PreviewEventCache | null = null;

    constructor(dependencies: AdapterDependencies) {
        this.#dependencies = dependencies;
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
        const { agent, cwd } = query;
        const signal = AbortSignal.any([query.signal, AbortSignal.timeout(60_000)]);
        const { sessionId } = request;
        signal.throwIfAborted();
        nativeSessionIdSchema.parse(request.nativeSessionId);
        if (agent.id !== "codex" || !(await revalidateExecutable(agent.agentIdentity))) {
            throw new AcpExecutionError(
                "The local Codex executable changed. Restart Mobius to discover it again.",
                {},
                "agent_executable_changed",
            );
        }
        this.#previewCache ??= openPreviewEventCache();
        const retainedEvents = new Map<number, { readonly event: SessionEventPayload; readonly characters: number }>();
        let nextEvent = 0;
        let oldestEvent = 0;
        let characters = 0;
        let dropped = false;
        const replay = await this.#dependencies.processes.runTransient(
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
                        const externalized = await this.#dependencies.contentExternalizer.update(
                            sessionId,
                            update,
                            signal,
                        );
                        const event: SessionEventPayload = {
                            type: "acp",
                            payload: decodeAcpSessionUpdate(JSON.stringify(externalized.event)),
                        };
                        const eventCharacters = JSON.stringify(event).length;
                        retainedEvents.set(nextEvent++, { event, characters: eventCharacters });
                        characters += eventCharacters;
                        while (
                            retainedEvents.size > SESSION_HISTORY_MESSAGE_LIMIT ||
                            characters > SESSION_HISTORY_CHARACTER_LIMIT
                        ) {
                            const removed = retainedEvents.get(oldestEvent);
                            if (removed === undefined) {
                                break;
                            }
                            retainedEvents.delete(oldestEvent++);
                            characters -= removed.characters;
                            dropped = true;
                        }
                    },
                    signal,
                );
            },
            async (runtime) => await runtime.closeProcess(),
        );
        const events = Array.from(retainedEvents.values(), ({ event }) => event);
        const generationId = createHash("sha256")
            .update(request.nativeSessionId)
            .update("\0")
            .update(JSON.stringify(events))
            .digest("hex");
        this.#previewCache.events.materialize(sessionId, generationId, events);
        const page = this.#previewCache.events.page(sessionId, request.eventLimit, request.cursor);
        return { ...page, truncated: page.truncated || replay.truncated || dropped };
    };
}
