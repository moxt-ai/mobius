import { grokBuildSessionConfigProtocol } from "./grok-build-session-config.ts";
import { type SessionConfigProtocol, standardSessionConfigProtocol } from "./session-config-protocol.ts";

export function sessionConfigProtocolForAgent(agentId: string): SessionConfigProtocol {
    return agentId === "grok-build" ? grokBuildSessionConfigProtocol : standardSessionConfigProtocol;
}
