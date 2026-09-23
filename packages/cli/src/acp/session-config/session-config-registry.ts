import { type SessionConfigProtocol, standardSessionConfigProtocol } from "./session-config-protocol.ts";

export function sessionConfigProtocolForAgent(_agentId: string): SessionConfigProtocol {
    return standardSessionConfigProtocol;
}
