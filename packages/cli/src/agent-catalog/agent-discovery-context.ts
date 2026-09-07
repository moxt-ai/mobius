export interface LocalAgentDiscoveryContext {
  readonly architecture?: NodeJS.Architecture;
  readonly defaultWorkspace: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  readonly signal: AbortSignal;
}
