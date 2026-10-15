import { isAbsolute, join } from "node:path";
import type { PlatformSupport } from "./contracts.ts";
import { posixOperations, processExists, readProcessTableWithPs } from "./posix.ts";

export const macosPlatform: PlatformSupport = {
    ...posixOperations,
    readProcessTable: () => readProcessTableWithPs("/bin/ps"),
    readProcessTableSynchronously: () => [],
    processExists,
    claudeCodeExecutablePaths: (environment) => {
        const paths = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
        const homeDirectory = environment["HOME"];
        if (homeDirectory !== undefined && isAbsolute(homeDirectory)) {
            paths.unshift(join(homeDirectory, ".local", "bin", "claude"));
        }
        return paths;
    },
};
