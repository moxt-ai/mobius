import { createHash } from "node:crypto";
import { methods } from "@agentclientprotocol/sdk";
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
    AdapterSessionCreateParams,
    NativeSessionQuery,
    SessionEventPage,
} from "../../native-history/preview-contract.ts";
import { nativeSessionIdSchema } from "../../protocol/native-session.ts";
import { AcpExecutionConnections } from "../execution-connections.ts";
import { createdNativeSessionId, normalizeOpenedSession, sessionWorkspace } from "../lifecycle-output.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { openPreviewEventCache, type PreviewEventCache } from "../preview-event-cache.ts";
import { AgentQueryProcesses } from "../query-processes.ts";
import { AcpSessionConnector } from "../session-events.ts";
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
    readonly #executionConnections: AcpExecutionConnections;
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
        this.#executionConnections = new AcpExecutionConnections(this.#contentExternalizer, fitCodexToolEvent);
        this.#queryProcesses = new AgentQueryProcesses(agent, dependencies.processes, this.#connector);
    }

    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => {
        this.#agent = agent;
        this.#queryProcesses.refreshAgent(agent);
    };
    readonly getCapabilities = async (query: NativeSessionQuery) => await this.#queryProcesses.capabilities(query);
    readonly #executionParams = (params: AdapterSessionCreateParams): AdapterSessionCreateParams => {
        const externalize = params.scope.externalizeUpdate;
        return externalize === undefined
            ? params
            : {
                  ...params,
                  scope: {
                      ...params.scope,
                      externalizeUpdate: (update, signal) => externalize(prepareCodexToolUpdate(update), signal),
                  },
              };
    };

    readonly createSession: Adapter["createSession"] = (params) =>
        this.#executionConnections.withConnection(this.#executionParams(params), async (execution, signal) => {
            const { connection } = execution;
            const response: unknown = await connection.race(
                connection.connection.agent.request(methods.agent.session.new, sessionWorkspace(params.scope), {
                    cancellationSignal: signal,
                }),
                "ACP agent exited while starting a session",
                signal,
            );
            const nativeSessionId = createdNativeSessionId(response);
            this.#executionConnections.bind(execution, nativeSessionId);
            return normalizeOpenedSession(execution, nativeSessionId, response, signal);
        });
    readonly forkSession: Adapter["forkSession"] = (params) =>
        this.#executionConnections.withConnection(this.#executionParams(params), async (execution, signal) => {
            const { connection } = execution;
            const response: unknown = await connection.race(
                connection.connection.agent.request(
                    methods.agent.session.fork,
                    {
                        ...sessionWorkspace(params.scope),
                        sessionId: nativeSessionIdSchema.parse(params.sourceNativeSessionId),
                    },
                    { cancellationSignal: signal },
                ),
                "ACP agent exited while forking a session",
                signal,
            );
            const nativeSessionId = createdNativeSessionId(response);
            this.#executionConnections.bind(execution, nativeSessionId);
            return normalizeOpenedSession(execution, nativeSessionId, response, signal);
        });
    readonly openSession: Adapter["openSession"] = (params) =>
        this.#executionConnections.withConnection(this.#executionParams(params), async (execution, signal) => {
            const { connection } = execution;
            const nativeSessionId = nativeSessionIdSchema.parse(params.nativeSessionId);
            this.#executionConnections.bind(execution, nativeSessionId);
            const response: unknown = await connection.race(
                connection.connection.agent.request(
                    methods.agent.session.resume,
                    { ...sessionWorkspace(params.scope), sessionId: nativeSessionId },
                    { cancellationSignal: signal },
                ),
                "ACP agent exited while resuming a session",
                signal,
            );
            return normalizeOpenedSession(execution, nativeSessionId, response, signal);
        });
    readonly openSessionWithReplay: Adapter["openSessionWithReplay"] = (params) =>
        this.#executionConnections.withConnection(this.#executionParams(params), async (execution, signal) => {
            const { connection } = execution;
            const nativeSessionId = nativeSessionIdSchema.parse(params.nativeSessionId);
            this.#executionConnections.bind(execution, nativeSessionId);
            const response: unknown = await connection.race(
                connection.connection.agent.request(
                    methods.agent.session.load,
                    { ...sessionWorkspace(params.scope), sessionId: nativeSessionId },
                    { cancellationSignal: signal },
                ),
                "ACP agent exited while loading a session",
                signal,
            );
            await connection.race(connection.events.drained(), "ACP agent exited while loading a session", signal);
            return normalizeOpenedSession(execution, nativeSessionId, response, signal);
        });
    readonly cancel: Adapter["cancel"] = async (params) => {
        // turn/interrupt leaves unified-exec commands alive, including tools whose
        // startup notification can arrive after the interrupted turn completes.
        // The session's owned process tree is the authoritative stop boundary.
        await this.#executionConnections.closeSession(params);
        return "closed";
    };
    readonly closeSession: Adapter["closeSession"] = (...args) => this.#executionConnections.closeSession(...args);
    readonly releaseSession: Adapter["releaseSession"] = (params) => this.#executionConnections.releaseSession(params);
    readonly prompt: Adapter["prompt"] = (...args) => this.#executionConnections.prompt(...args);
    readonly steer: Adapter["steer"] = (...args) => this.#executionConnections.steer(...args);
    readonly renameSession: Adapter["renameSession"] = (...args) => this.#executionConnections.renameSession(...args);
    readonly configureSession: Adapter["configureSession"] = (...args) =>
        this.#executionConnections.configureSession(...args);
    readonly listSessions: Adapter["listSessions"] = async ({ query, cursor }) =>
        await this.#queryProcesses.listNativeSessions(query, cursor);
    readonly findSession: Adapter["findSession"] = ({ query, nativeSessionId, budget }) =>
        findNativeSession(this.listSessions, query, nativeSessionId, budget);
    readonly close = async (): Promise<void> => {
        await runCleanup(
            () => this.#queryProcesses.close(),
            () => this.#executionConnections.close(),
            () => this.#previewCache?.close(),
        );
    };

    readonly readSessionHistory: Adapter["readSessionHistory"] = async ({
        query,
        request,
    }): Promise<SessionEventPage> => {
        const { agent, cwd } = query;
        const signal = AbortSignal.any([query.signal, AbortSignal.timeout(60_000)]);
        const sessionId = request.nativeSessionId;
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
                        const externalized =
                            query.externalizeUpdate === undefined
                                ? await this.#contentExternalizer.update(sessionId, update, signal)
                                : await query.externalizeUpdate(prepareCodexToolUpdate(update), signal);
                        for (const event of externalized.events) {
                            events.push({
                                type: "acp",
                                payload: decodeAcpSessionUpdate(JSON.stringify(fitCodexToolEvent(event))),
                            });
                        }
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
