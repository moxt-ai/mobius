import { runCleanup } from "../../../util/run-cleanup.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import type { Adapter, AdapterDependencies, NativeSessionQuery } from "../../native-history/preview-contract.ts";
import { nativeSessionIdSchema } from "../../protocol/native-session.ts";
import { AcpExecutionConnections } from "../execution-connections.ts";
import { createdNativeSessionId, normalizeOpenedSession, sessionWorkspace } from "../lifecycle-output.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { AgentQueryProcesses } from "../query-processes.ts";
import { AcpSessionConnector } from "../session-events.ts";

/**
 * Pi replays its stored session messages as live ACP session updates during
 * `session/load`, so previews resume the saved session over ACP.
 */
export class PiAdapter implements Adapter {
    readonly #queryProcesses: AgentQueryProcesses;
    readonly #connector: AcpSessionConnector;
    readonly #executionConnections: AcpExecutionConnections;

    constructor(agent: AcpAgentDefinition, dependencies: AdapterDependencies) {
        this.#connector = new AcpSessionConnector(dependencies.contentExternalizer);
        this.#executionConnections = new AcpExecutionConnections(dependencies.contentExternalizer);
        this.#queryProcesses = new AgentQueryProcesses(agent, dependencies.processes, this.#connector);
    }

    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => this.#queryProcesses.refreshAgent(agent);
    readonly getCapabilities = async (query: NativeSessionQuery) => await this.#queryProcesses.capabilities(query);
    readonly createSession: Adapter["createSession"] = (params) =>
        this.#executionConnections.withConnection(params, async (execution, signal) => {
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
        this.#executionConnections.withConnection(params, async (execution, signal) => {
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
        this.#executionConnections.withConnection(params, async (execution, signal) => {
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
        this.#executionConnections.withConnection(params, async (execution, signal) => {
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
    readonly cancel: Adapter["cancel"] = (...args) => this.#executionConnections.cancel(...args);
    readonly closeSession: Adapter["closeSession"] = (...args) => this.#executionConnections.closeSession(...args);
    readonly releaseSession: Adapter["releaseSession"] = (params) => this.#executionConnections.releaseSession(params);
    readonly readNativeHistoryRevision: Adapter["readNativeHistoryRevision"] = (params) =>
        this.#executionConnections.readNativeHistoryRevision(params);
    readonly prompt: Adapter["prompt"] = (...args) => this.#executionConnections.prompt(...args);
    readonly steer: Adapter["steer"] = (...args) => this.#executionConnections.steer(...args);
    readonly renameSession: Adapter["renameSession"] = (...args) => this.#executionConnections.renameSession(...args);
    readonly configureSession: Adapter["configureSession"] = (...args) =>
        this.#executionConnections.configureSession(...args);
    readonly listSessions: Adapter["listSessions"] = async ({ query, cursor }) =>
        await this.#queryProcesses.listNativeSessions(query, cursor);
    readonly findSession: Adapter["findSession"] = ({ query, nativeSessionId, budget }) =>
        findNativeSession(this.listSessions, query, nativeSessionId, budget);
    readonly readSessionHistory: Adapter["readSessionHistory"] = async ({ query, request }) =>
        await this.#queryProcesses.previewSessionEvents(query, request);
    readonly close = async (): Promise<void> =>
        await runCleanup(
            () => this.#queryProcesses.close(),
            () => this.#executionConnections.close(),
        );
}

import { methods } from "@agentclientprotocol/sdk";
