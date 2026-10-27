import type { AgentConnectionLaunchOptions } from "../../connection/agent-connection.ts";
import { EndpointAgentConnection } from "../../connection/endpoint-agent-connection.ts";
import { ClaudeAcpEndpoint } from "../../harness/claude/endpoint.ts";

export class ClaudeAgentConnection extends EndpointAgentConnection {
    constructor(options: AgentConnectionLaunchOptions) {
        const endpoint = new ClaudeAcpEndpoint({
            command: options.command,
            cwd: options.cwd,
            environment: options.environment,
            onSessionUpdate: options.client.onUpdate,
            onBackgroundActivity: (active) => options.onBackgroundActivity?.(active),
        });
        super(endpoint, options.client);
    }
}
