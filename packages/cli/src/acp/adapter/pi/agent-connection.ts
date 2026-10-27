import type { AgentConnectionLaunchOptions } from "../../connection/agent-connection.ts";
import { EndpointAgentConnection } from "../../connection/endpoint-agent-connection.ts";
import { PiAcpEndpoint } from "../../harness/pi/endpoint.ts";

export class PiAgentConnection extends EndpointAgentConnection {
    constructor(options: AgentConnectionLaunchOptions) {
        const endpoint = new PiAcpEndpoint({
            command: options.command,
            cwd: options.cwd,
            environment: options.environment,
            onSessionUpdate: options.client.onUpdate,
            onBackgroundActivity: (active) => options.onBackgroundActivity?.(active),
        });
        super(endpoint, options.client);
    }
}
