import { type AgentCapabilities, type ClientConnection, methods } from "@agentclientprotocol/sdk";

import { AgentProbeError } from "../agent-probe-error.ts";

export async function verifySessionCreation(
    connection: ClientConnection,
    capabilities: AgentCapabilities,
    defaultWorkspace: string,
    signal: AbortSignal,
    label: string,
): Promise<void> {
    const session = await connection.agent.request(
        methods.agent.session.new,
        {
            additionalDirectories: [],
            cwd: defaultWorkspace,
            mcpServers: [],
        },
        { cancellationSignal: signal },
    );
    if (session.sessionId.length === 0) {
        throw new AgentProbeError("acp_incompatible", `${label} returned an invalid ACP session`);
    }
    if (capabilities.sessionCapabilities?.close != null) {
        await connection.agent.request(
            methods.agent.session.close,
            { sessionId: session.sessionId },
            { cancellationSignal: signal },
        );
    }
}
