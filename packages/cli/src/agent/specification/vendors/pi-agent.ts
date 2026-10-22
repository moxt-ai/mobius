import { createHash } from "node:crypto";
import { join } from "node:path";
import {
    type AgentCapabilities,
    type ClientConnection,
    type InitializeResponse,
    methods,
} from "@agentclientprotocol/sdk";
import type { InProcessAcpEndpointFactory } from "../../../acp/agent/in-process-endpoint.ts";
import { PiAcpEndpoint } from "../../../acp/harness/pi/endpoint.ts";
import { readStateDirectory } from "../../../storage/state-directory.ts";
import type { ResolvedExecutable } from "../../../util/process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../../discovery/agent-discovery-context.ts";
import { AgentProbeError } from "../../discovery/agent-probe-error.ts";
import { InProcessAcpAgentSpecification } from "../agent-specification.ts";

const ACP_PROBE_TIMEOUT_MILLISECONDS = 30_000;

export class PiAgentSpecification extends InProcessAcpAgentSpecification {
    override readonly acpProbeTimeoutMilliseconds = ACP_PROBE_TIMEOUT_MILLISECONDS;
    readonly agentExecutable = "pi";
    readonly createEndpoint: InProcessAcpEndpointFactory = (options) => new PiAcpEndpoint(options);
    // The Pi ACP fork inlines embedded prompt resources into the turn message, so Mobius
    // keeps the adapter's opt-in capability flag enabled for every launch it owns.
    override readonly createLaunchEnvironment = async (
        _agent: ResolvedExecutable,
        context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => {
        // Pi encodes the workspace path itself into a native session directory name. Long nested
        // workspaces therefore exceed filesystem name limits before Mobius can run a readiness turn.
        // Keep persistence, but derive a bounded, stable directory from the resolved workspace.
        const workspaceHash = createHash("sha256").update(context.defaultWorkspace).digest("hex").slice(0, 24);
        const sessionDirectory = join(
            readStateDirectory(context.environment),
            "agents",
            "pi",
            "sessions",
            workspaceHash,
        );
        return Object.freeze({
            PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true",
            MOBIUS_PI_SESSION_DIR: sessionDirectory,
        });
    };
    readonly id = "pi";
    readonly label = "Pi";
    override readonly minimumSupportedAgentVersion = "0.85.0";
    override readonly maximumTestedAgentVersion = "1.1.0";
    override readonly authenticationCommand = (): string => "pi";
    constructor() {
        super("MOBIUS_PI_PATH");
    }

    override readonly verifyAcp = async (
        connection: ClientConnection,
        initialized: InitializeResponse,
        defaultWorkspace: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        if (capabilities.loadSession !== true) {
            throw new AgentProbeError("acp_incompatible", "Pi ACP adapter does not support session recovery");
        }
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
            throw new AgentProbeError("acp_incompatible", "Pi ACP adapter returned an invalid session");
        }
        const prompt = await connection.agent.request(
            methods.agent.session.prompt,
            {
                prompt: [{ text: "/session", type: "text" }],
                sessionId: session.sessionId,
            },
            { cancellationSignal: signal },
        );
        if (prompt.stopReason !== "end_turn") {
            throw new AgentProbeError("acp_incompatible", "Pi ACP adapter did not complete its conformance prompt");
        }
    };
}
