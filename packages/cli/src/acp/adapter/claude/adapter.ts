import { runCleanup } from "../../../util/run-cleanup.ts";
import type {
    Adapter,
    AdapterDependencies,
    NativeSessionLookupBudget,
    NativeSessionPreviewRequest,
    NativeSessionQuery,
} from "../../native-history/preview-contract.ts";
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

    constructor(dependencies: AdapterDependencies) {
        this.#connector = new AcpSessionConnector(dependencies.contentExternalizer);
        this.#liveSessions = new AcpLiveSessions(dependencies.contentExternalizer);
        this.#queryProcesses = new AgentQueryProcesses(dependencies.processes, this.#connector);
    }

    readonly getCapabilities = async (query: NativeSessionQuery) => await this.#queryProcesses.capabilities(query);
    readonly connectSession = (options: LiveSessionConnectionOptions) => this.#liveSessions.connectSession(options);
    readonly prompt: Adapter["prompt"] = (...args) => this.#liveSessions.prompt(...args);
    readonly steer: Adapter["steer"] = (...args) => this.#liveSessions.steer(...args);
    readonly renameSession: Adapter["renameSession"] = (...args) => this.#liveSessions.renameSession(...args);
    readonly configureSession: Adapter["configureSession"] = (...args) => this.#liveSessions.configureSession(...args);
    readonly listSessions = async (query: NativeSessionQuery, cursor: string | null) =>
        await this.#queryProcesses.listNativeSessions(query, cursor);
    readonly findSession = (query: NativeSessionQuery, nativeSessionId: string, budget: NativeSessionLookupBudget) =>
        findNativeSession(this.listSessions, query, nativeSessionId, budget);
    readonly readSessionHistory = async (query: NativeSessionQuery, request: NativeSessionPreviewRequest) =>
        await this.#queryProcesses.previewSessionEvents(query, request);
    readonly close = async (): Promise<void> =>
        await runCleanup(
            () => this.#queryProcesses.close(),
            () => this.#liveSessions.close(),
        );
}
