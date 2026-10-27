import type { AgentConnectionLaunchOptions } from "../../connection/agent-connection.ts";
import { EndpointAgentConnection } from "../../connection/endpoint-agent-connection.ts";
import { PiAcpEndpoint } from "../../harness/pi/endpoint.ts";

export class PiAgentConnection extends EndpointAgentConnection {
    constructor(options: AgentConnectionLaunchOptions) {
        let message:
            | { readonly kind: "none" }
            | {
                  readonly kind: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
                  readonly messageId: string;
              } = { kind: "none" };
        const endpoint = new PiAcpEndpoint({
            command: options.command,
            cwd: options.cwd,
            environment: options.environment,
            onSessionUpdate: async (notification) => {
                const update: SessionUpdate = notification.update;
                switch (update.sessionUpdate) {
                    case "user_message_chunk":
                    case "agent_message_chunk":
                    case "agent_thought_chunk": {
                        if (message.kind !== update.sessionUpdate) {
                            message = { kind: update.sessionUpdate, messageId: randomUUID() };
                        }
                        await options.client.onUpdate({
                            ...notification,
                            update: { ...update, messageId: message.messageId },
                        });
                        return;
                    }
                    default:
                        message = { kind: "none" };
                        await options.client.onUpdate({ ...notification, update });
                }
            },
            onBackgroundActivity: (active) => options.onBackgroundActivity?.(active),
        });
        super(endpoint, options.client);
    }
}

import { randomUUID } from "node:crypto";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
