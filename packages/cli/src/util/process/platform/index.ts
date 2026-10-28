import type { ProcessPlatformSupport } from "./contracts.ts";
import { linuxProcessPlatform } from "./linux.ts";
import { macosProcessPlatform } from "./macos.ts";
import { posixOperations, processExists, readProcessTableWithPs } from "./posix.ts";
import { windowsProcessPlatform } from "./windows.ts";

// Preserve the existing fallback for other POSIX hosts.
const fallbackPlatform: ProcessPlatformSupport = {
    ...posixOperations,
    readProcessTable: () => readProcessTableWithPs("/usr/bin/ps"),
    readProcessTableSynchronously: () => [],
    processExists,
};
const platforms: ReadonlyMap<NodeJS.Platform, ProcessPlatformSupport> = new Map([
    ["linux", linuxProcessPlatform],
    ["darwin", macosProcessPlatform],
    ["win32", windowsProcessPlatform],
]);

export function processPlatformSupportFor(platform: NodeJS.Platform): ProcessPlatformSupport {
    return platforms.get(platform) ?? fallbackPlatform;
}
