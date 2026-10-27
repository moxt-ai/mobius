export interface LocalAgentDiscoveryContext {
    readonly architecture?: NodeJS.Architecture;
    /** The Runtime's local data directory, where Agents that Mobius configures keep their Mobius-owned state. */
    readonly dataDirectory: string;
    readonly defaultWorkspace: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly platform?: NodeJS.Platform;
    readonly signal: AbortSignal;
}
