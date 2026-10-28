export interface PlatformSupport {
    readonly controlSocketPath: (installationHash: string) => string;
    readonly prepareControlSocket: (path: string) => Promise<void>;
    readonly secureControlSocket: (path: string) => Promise<void>;
    readonly removeControlSocket: (path: string) => Promise<void>;
    readonly validatePathPermissions: (
        path: string,
        directory: boolean,
        privateAccess: boolean,
        signal: AbortSignal,
    ) => Promise<void>;
    readonly claudeCodeExecutablePaths: (environment: Readonly<NodeJS.ProcessEnv>) => readonly string[];
}
