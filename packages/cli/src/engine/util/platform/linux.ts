import { isAbsolute, join } from "node:path";
import type { PlatformSupport } from "./contracts.ts";
import { posixOperations } from "./posix.ts";

export const linuxPlatform: PlatformSupport = {
    ...posixOperations,
    claudeCodeExecutablePaths: (environment) => {
        const homeDirectory = environment["HOME"];
        return homeDirectory !== undefined && isAbsolute(homeDirectory)
            ? [join(homeDirectory, ".local", "bin", "claude")]
            : [];
    },
};
