import type { ChildProcess } from "node:child_process";

export interface ProcessTreeIdentity {
    readonly processGroupId: number;
    readonly processId: number;
}

export interface ProcessTableEntry extends ProcessTreeIdentity {
    readonly parentProcessId: number;
}

export interface ProcessLaunch {
    readonly command: string;
    readonly arguments: readonly string[];
}

export interface ProcessPlatformSupport {
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
    readonly readProcessTable: () => Promise<readonly ProcessTableEntry[]>;
    readonly readProcessTableSynchronously: () => readonly ProcessTableEntry[];
    readonly processExists: (processId: number) => boolean;
}
