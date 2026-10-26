import type {
    Adapter,
    AdapterDependencies,
    NativeSessionPreviewRequest,
    NativeSessionQuery,
} from "../../native-history/preview-contract.ts";
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

    readonly capabilities = async (query: NativeSessionQuery) => await this.#queryProcesses.capabilities(query);
    readonly connectSession = (options: AdapterSessionConnectionOptions) => this.#connector.connectSession(options);
    readonly listNativeSessions = async (query: NativeSessionQuery, cursor: string | null) =>
        await this.#queryProcesses.listNativeSessions(query, cursor);
    readonly previewSessionEvents = async (query: NativeSessionQuery, request: NativeSessionPreviewRequest) =>
        await this.#queryProcesses.previewSessionEvents(query, request);
    readonly close = async (): Promise<void> => await this.#queryProcesses.close();
}
