import type {
    Adapter,
    AdapterDependencies,
    NativeSessionLookupBudget,
    NativeSessionPreviewRequest,
    NativeSessionQuery,
} from "../../native-history/preview-contract.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { AgentQueryProcesses } from "../query-processes.ts";
import { AcpSessionConnector, type AdapterSessionConnectionOptions } from "../session-events.ts";

/**
 * Claude Code stores history that its harness replays as live ACP session updates
 * during `session/load`, so previews resume the saved session over ACP.
 */
export class ClaudeAdapter implements Adapter {
    readonly #queryProcesses: AgentQueryProcesses;
    readonly #connector: AcpSessionConnector;

    constructor(dependencies: AdapterDependencies) {
        this.#connector = new AcpSessionConnector(dependencies.contentExternalizer);
        this.#queryProcesses = new AgentQueryProcesses(dependencies.processes, this.#connector);
    }

    readonly getCapabilities = async (query: NativeSessionQuery) => await this.#queryProcesses.capabilities(query);
    readonly connectSession = (options: AdapterSessionConnectionOptions) => this.#connector.connectSession(options);
    readonly listSessions = async (query: NativeSessionQuery, cursor: string | null) =>
        await this.#queryProcesses.listNativeSessions(query, cursor);
    readonly findSession = (query: NativeSessionQuery, nativeSessionId: string, budget: NativeSessionLookupBudget) =>
        findNativeSession(this.listSessions, query, nativeSessionId, budget);
    readonly readSessionHistory = async (query: NativeSessionQuery, request: NativeSessionPreviewRequest) =>
        await this.#queryProcesses.previewSessionEvents(query, request);
    readonly close = async (): Promise<void> => await this.#queryProcesses.close();
}
