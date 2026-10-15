import type { PlatformSupport } from "./contracts.ts";
import { linuxPlatform } from "./linux.ts";
import { macosPlatform } from "./macos.ts";
import { posixOperations, processExists, readProcessTableWithPs } from "./posix.ts";
import { windowsPlatform } from "./windows.ts";

// Preserve the existing fallback for other POSIX hosts.
const fallbackPlatform: PlatformSupport = {
    ...posixOperations,
    readProcessTable: () => readProcessTableWithPs("/usr/bin/ps"),
    readProcessTableSynchronously: () => [],
    processExists,
    claudeCodeExecutablePaths: () => [],
};
const platforms: ReadonlyMap<NodeJS.Platform, PlatformSupport> = new Map([
    ["linux", linuxPlatform],
    ["darwin", macosPlatform],
    ["win32", windowsPlatform],
]);

export function platformSupportFor(platform: NodeJS.Platform): PlatformSupport {
    return platforms.get(platform) ?? fallbackPlatform;
}
