import { createHash } from "node:crypto";
import { decodeAcpSessionUpdate, type SessionEventPayload } from "@moxt-ai/mobius-sdk/protocol";
import { revalidateExecutable, stopProcessTree } from "../../../util/process/executable.ts";
import { runCleanup } from "../../../util/run-cleanup.ts";
import { AcpExecutionError } from "../../acp-error.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import type { AcpContentExternalizer } from "../../content/content-externalizer.ts";
import { CodexAppServerClient } from "../../harness/codex/app-server-client.ts";
import { replayCodexHistory } from "../../harness/codex/history.ts";
import type {
    Adapter,
    AdapterDependencies,
    NativeSessionPreviewRequest,
    SessionEventPage,
} from "../../native-history/preview-contract.ts";
import { nativeSessionIdSchema } from "../../protocol/native-session.ts";
import { AcpLiveSessions } from "../live-sessions.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { openPreviewEventCache, type PreviewEventCache } from "../preview-event-cache.ts";
import { AgentQueryProcesses } from "../query-processes.ts";
import { AcpSessionConnector, type LiveSessionConnectionOptions } from "../session-events.ts";
import { fitCodexToolEvent, prepareCodexToolUpdate } from "./tool-event.ts";

/**
 * Previews saved Codex threads by reading the Codex app-server directly. The read is
 * short-lived and never resumes the source thread, so it needs no writer lock; ACP
 * `session/load` remains the fallback for resuming the conversation.
 */
export class CodexAdapter implements Adapter {
    #agent: AcpAgentDefinition;
    readonly #queryProcesses: AgentQueryProcesses;
    readonly #connector: AcpSessionConnector;
    readonly #liveSessions: AcpLiveSessions;
    readonly #dependencies: AdapterDependencies;
    readonly #contentExternalizer: Pick<AcpContentExternalizer, "update">;
    #previewCache: PreviewEventCache | null = null;

    constructor(agent: AcpAgentDefinition, dependencies: AdapterDependencies) {
        this.#agent = agent;
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
        this.#liveSessions = new AcpLiveSessions(this.#contentExternalizer, fitCodexToolEvent);
        this.#queryProcesses = new AgentQueryProcesses(agent, dependencies.processes, this.#connector);
    }

    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => {
        this.#agent = agent;
        this.#queryProcesses.refreshAgent(agent);
    };
    readonly getCapabilities: Adapter["getCapabilities"] = (cwd, signal) =>
        this.#queryProcesses.capabilities(cwd, signal);
    readonly connectSession = (options: LiveSessionConnectionOptions) => this.#liveSessions.connectSession(options);
    readonly cancel: Adapter["cancel"] = (...args) => this.#liveSessions.cancel(...args);
    readonly closeSession: Adapter["closeSession"] = (...args) => this.#liveSessions.closeSession(...args);
    readonly prompt: Adapter["prompt"] = (...args) => this.#liveSessions.prompt(...args);
    readonly steer: Adapter["steer"] = (...args) => this.#liveSessions.steer(...args);
    readonly renameSession: Adapter["renameSession"] = (...args) => this.#liveSessions.renameSession(...args);
    readonly configureSession: Adapter["configureSession"] = (...args) => this.#liveSessions.configureSession(...args);
    readonly listSessions: Adapter["listSessions"] = (cwd, cursor, signal) =>
        this.#queryProcesses.listNativeSessions(cwd, cursor, signal);
    readonly findSession: Adapter["findSession"] = (cwd, nativeSessionId, budget, signal) =>
        findNativeSession(this.listSessions, cwd, nativeSessionId, budget, signal);
    readonly close = async (): Promise<void> => {
        await runCleanup(
            () => this.#queryProcesses.close(),
            () => this.#liveSessions.close(),
            () => this.#previewCache?.close(),
        );
    };

    readonly readSessionHistory = async (
        cwd: string,
        _additionalDirectories: readonly string[],
        request: NativeSessionPreviewRequest,
        cancellation: AbortSignal,
    ): Promise<SessionEventPage> => {
        const agent = this.#agent;
        const signal = AbortSignal.any([cancellation, AbortSignal.timeout(60_000)]);
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
