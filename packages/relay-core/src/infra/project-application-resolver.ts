export interface ProjectApplicationResolver {
    readonly resolveApplicationId: (projectId: string, signal: AbortSignal) => Promise<string>;
}
