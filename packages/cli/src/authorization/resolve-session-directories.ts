import { basename } from "node:path";
import { LocalAuthorizationError } from "./local-authorization-error.ts";
import type { WorkspaceDirectoryService } from "./workspace-directory.ts";

class ResolvedSessionDirectories {
    readonly additionalDirectories: readonly string[];
    readonly additionalDirectoryEntries: readonly {
        readonly directoryId: string;
        readonly name: string;
    }[];
    readonly cwd: string;

    constructor(
        cwd: string,
        additionalDirectories: readonly string[],
        additionalDirectoryEntries: readonly {
            readonly directoryId: string;
            readonly name: string;
        }[],
    ) {
        this.additionalDirectories = additionalDirectories;
        this.additionalDirectoryEntries = additionalDirectoryEntries;
        this.cwd = cwd;
    }
}

export async function resolveSessionDirectories(
    directories: WorkspaceDirectoryService,
    bindingId: string,
    directoryId: string,
    additionalDirectoryIds: readonly string[],
    signal: AbortSignal,
): Promise<ResolvedSessionDirectories> {
    const cwd = await directories.resolve(bindingId, directoryId, signal);
    const additionalDirectories: string[] = [];
    const additionalDirectoryEntries: {
        readonly directoryId: string;
        readonly name: string;
    }[] = [];
    const unique = new Set<string>([cwd]);
    for (const additionalDirectoryId of additionalDirectoryIds) {
        const directory = await directories.resolve(bindingId, additionalDirectoryId, signal);
        if (unique.has(directory)) {
            throw new LocalAuthorizationError("Workspace directories must resolve to distinct locations");
        }
        unique.add(directory);
        additionalDirectories.push(directory);
        additionalDirectoryEntries.push({
            directoryId: additionalDirectoryId,
            name: basename(directory),
        });
    }
    return new ResolvedSessionDirectories(cwd, additionalDirectories, additionalDirectoryEntries);
}
