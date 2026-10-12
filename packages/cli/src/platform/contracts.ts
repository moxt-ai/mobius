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

export interface PlatformSupport {
    readonly readProcessTable: () => Promise<readonly ProcessTableEntry[]>;
    readonly readProcessTableSynchronously: () => readonly ProcessTableEntry[];
    readonly processExists: (processId: number) => boolean;
    readonly workBuddyExecutablePaths: (environment: Readonly<NodeJS.ProcessEnv>) => readonly string[];
    readonly openCodeArchives: Readonly<Partial<Record<NodeJS.Architecture, ArchiveRelease>>>;
    readonly grokDependencies: Readonly<Partial<Record<NodeJS.Architecture, NpmDependencyRelease>>>;
}
