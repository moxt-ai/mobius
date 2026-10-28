import type { AgentConnectionLaunchOptions } from "../../connection/agent-connection.ts";
import { EndpointAgentConnection } from "../../connection/endpoint-agent-connection.ts";
import { CodexAcpAgent } from "../../harness/codex/agent.ts";

export class CodexAgentConnection extends EndpointAgentConnection {
    constructor(options: AgentConnectionLaunchOptions) {
        const endpoint = new CodexAcpAgent({
            command: options.command,
            cwd: options.cwd,
            environment: options.environment,
            onSessionUpdate: options.client.onUpdate,
            onBackgroundActivity: (active) => options.onBackgroundActivity?.(active),
        });
        super(endpoint, options.client);
    }
}
