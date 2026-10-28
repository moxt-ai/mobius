import type { AgentConnectionLaunchOptions } from "../../connection/agent-connection.ts";
import { EndpointAgentConnection } from "../../connection/endpoint-agent-connection.ts";
import { ClaudeAcpEndpoint } from "../../harness/claude/endpoint.ts";
import type { ClaudeSessionNotification } from "../../harness/claude/upstream/dist/lib.js";

export class ClaudeAgentConnection extends EndpointAgentConnection {
    constructor(options: AgentConnectionLaunchOptions) {
        const endpoint = new ClaudeAcpEndpoint({
            command: options.command,
            cwd: options.cwd,
            environment: options.environment,
            onSessionUpdate: async (notification: ClaudeSessionNotification) => {
                await options.client.onUpdate(notification);
            },
            onBackgroundActivity: (activity) => options.onBackgroundActivity?.(activity),
        });
        super(endpoint, options.client);
    }
}
