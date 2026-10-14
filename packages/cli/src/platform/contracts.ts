import type { ChildProcess } from "node:child_process";

export interface ProcessTreeIdentity {
    readonly processGroupId: number;
    readonly processId: number;
}

export interface ProcessTableEntry extends ProcessTreeIdentity {
    readonly parentProcessId: number;
}

export interface ArchiveRelease {
    readonly asset: string;
    readonly sha256: string;
    readonly format: "zip" | "tar.gz";
}

export interface NpmDependencyRelease {
    readonly name: string;
    readonly integrity: string;
    readonly tarballUrl: string;
}

export interface ProcessLaunch {
    readonly command: string;
    readonly arguments: readonly string[];
}

export interface PlatformSupport {
    readonly controlSocketPath: (installationHash: string) => string;
    readonly prepareControlSocket: (path: string) => Promise<void>;
    readonly secureControlSocket: (path: string) => Promise<void>;
    readonly removeControlSocket: (path: string) => Promise<void>;

    readonly pathDelimiter: string;
    readonly environmentValue: (environment: Readonly<NodeJS.ProcessEnv>, name: string) => string | undefined;
    readonly executableExtensions: (name: string, environment: Readonly<NodeJS.ProcessEnv>) => readonly string[];
    readonly resolveExecutableTarget: (path: string) => Promise<string>;
    readonly executableLaunch: (command: string, args: readonly string[]) => ProcessLaunch;
    readonly spawnOptions: { readonly detached: boolean; readonly windowsHide: boolean };
    readonly signalCapturedProcesses: (
        processes: readonly ProcessTreeIdentity[],
        rootProcessId: number,
        signal: number,
    ) => void;
    readonly terminateProcess: (child: ChildProcess, signal: NodeJS.Signals) => void;
    readonly validatePathPermissions: (
        path: string,
        directory: boolean,
        privateAccess: boolean,
        signal: AbortSignal,
    ) => Promise<void>;

    readonly readProcessTable: () => Promise<readonly ProcessTableEntry[]>;
    readonly readProcessTableSynchronously: () => readonly ProcessTableEntry[];
    readonly processExists: (processId: number) => boolean;
    readonly claudeCodeExecutablePaths: (environment: Readonly<NodeJS.ProcessEnv>) => readonly string[];
    readonly workBuddyExecutablePaths: (environment: Readonly<NodeJS.ProcessEnv>) => readonly string[];
    readonly openCodeArchives: Readonly<Partial<Record<NodeJS.Architecture, ArchiveRelease>>>;
    readonly grokDependencies: Readonly<Partial<Record<NodeJS.Architecture, NpmDependencyRelease>>>;
}
