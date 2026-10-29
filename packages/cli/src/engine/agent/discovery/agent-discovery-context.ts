export interface AgentProbeDiagnostic {
    readonly agentId: string;
    readonly source: "agent_version" | "adapter_version" | "acp_readiness";
    readonly event: "agent_probe_failed" | "agent_probe_cancelled";
    readonly attempt: number;
    readonly elapsedMilliseconds: number;
    readonly timeoutMilliseconds: number;
    readonly failure: unknown;
}

export interface LocalAgentDiscoveryContext {
    readonly architecture?: NodeJS.Architecture;
    /** The Runtime's local data directory, where Agents that Mobius configures keep their Mobius-owned state. */
    readonly dataDirectory: string;
    readonly defaultWorkspace: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly platform?: NodeJS.Platform;
    readonly onProbeDiagnostic?: (diagnostic: AgentProbeDiagnostic) => void;
    readonly signal: AbortSignal;
}
