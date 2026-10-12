import type { PlatformSupport } from "./contracts.ts";
import { linuxPlatform } from "./linux.ts";
import { macosPlatform } from "./macos.ts";
import { processExists, readProcessTableWithPs } from "./posix.ts";

// Preserve the existing fallback for other POSIX hosts and the empty Windows process table.
const fallbackPlatform: PlatformSupport = {
    readProcessTable: () => readProcessTableWithPs("/usr/bin/ps"),
    readProcessTableSynchronously: () => [],
    processExists,
    workBuddyExecutablePaths: () => [],
    openCodeArchives: {},
    grokDependencies: {},
};
const platforms: ReadonlyMap<NodeJS.Platform, PlatformSupport> = new Map([
    ["linux", linuxPlatform],
    ["darwin", macosPlatform],
    ["win32", { ...fallbackPlatform, readProcessTable: () => Promise.resolve([]) }],
]);

export function platformSupportFor(platform: NodeJS.Platform): PlatformSupport {
    return platforms.get(platform) ?? fallbackPlatform;
}
