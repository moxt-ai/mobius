import { CodexAgentConnection } from "../../../acp/adapter/codex/agent-connection.ts";
import type { AgentConnectionFactory } from "../../../acp/connection/agent-connection.ts";
import { InProcessAcpAgentSpecification } from "../agent-specification.ts";

// Codex speaks its own app-server protocol rather than ACP, so Mobius hosts the ACP Agent in-process
// and drives `codex app-server` directly. There is no adapter package to install or version-probe.
export class CodexAgentSpecification extends InProcessAcpAgentSpecification {
    override readonly versionProbeTimeoutMilliseconds = 10_000;
    readonly agentExecutable = "codex";
    readonly createConnection: AgentConnectionFactory = (options) => new CodexAgentConnection(options);
    readonly id = "codex";
    readonly label = "Codex";
    override readonly minimumSupportedAgentVersion = "0.153.0";
    override readonly maximumTestedAgentVersion = "0.154.0";

    constructor() {
        super("MOBIUS_CODEX_PATH");
    }
}
