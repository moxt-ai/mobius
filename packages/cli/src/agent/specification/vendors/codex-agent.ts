import type { InProcessAcpEndpointFactory } from "../../../acp/agent/in-process-endpoint.ts";
import { CodexAcpAgent } from "../../../acp/harness/codex/agent.ts";
import { InProcessAcpAgentDefinition } from "../agent-specification.ts";

// Codex speaks its own app-server protocol rather than ACP, so Mobius hosts the ACP Agent in-process
// and drives `codex app-server` directly. There is no adapter package to install or version-probe.
export class CodexAgentSpecification extends InProcessAcpAgentDefinition {
    override readonly versionProbeTimeoutMilliseconds = 10_000;
    readonly agentExecutable = "codex";
    readonly createEndpoint: InProcessAcpEndpointFactory = (options) => new CodexAcpAgent(options);
    readonly id = "codex";
    readonly label = "Codex";
    override readonly minimumSupportedAgentVersion = "0.153.0";
    override readonly maximumTestedAgentVersion = "0.154.0";

    constructor() {
        super("MOBIUS_CODEX_PATH");
    }
}
