import { runCleanup } from "../../../util/run-cleanup.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import type { Adapter, AdapterDependencies } from "../../native-history/preview-contract.ts";
import { AcpLiveSessions } from "../live-sessions.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { AgentQueryProcesses } from "../query-processes.ts";
import { AcpSessionConnector, type LiveSessionConnectionOptions } from "../session-events.ts";

/**
 * Claude Code stores history that its harness replays as live ACP session updates
 * during `session/load`, so previews resume the saved session over ACP.
 */
export class ClaudeAdapter implements Adapter {
    readonly #queryProcesses: AgentQueryProcesses;
    readonly #connector: AcpSessionConnector;
    readonly #liveSessions: AcpLiveSessions;

    constructor(agent: AcpAgentDefinition, dependencies: AdapterDependencies) {
        this.#connector = new AcpSessionConnector(dependencies.contentExternalizer);
        this.#liveSessions = new AcpLiveSessions(dependencies.contentExternalizer);
        this.#queryProcesses = new AgentQueryProcesses(agent, dependencies.processes, this.#connector);
    }

    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => this.#queryProcesses.refreshAgent(agent);
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
    readonly readSessionHistory: Adapter["readSessionHistory"] = (cwd, additionalDirectories, request, signal) =>
        this.#queryProcesses.previewSessionEvents(cwd, additionalDirectories, request, signal);
    readonly close = async (): Promise<void> =>
        await runCleanup(
            () => this.#queryProcesses.close(),
            () => this.#liveSessions.close(),
        );
}
