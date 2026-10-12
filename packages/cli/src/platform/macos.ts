import { isAbsolute, join } from "node:path";
import type { PlatformSupport } from "./contracts.ts";
import { posixOperations, processExists, readProcessTableWithPs } from "./posix.ts";

const WORKBUDDY_MACOS_EXECUTABLE_PATH = Object.freeze([
    "WorkBuddy.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "cli",
    "bin",
    "codebuddy",
]);

export const macosPlatform: PlatformSupport = {
    ...posixOperations,
    readProcessTable: () => readProcessTableWithPs("/bin/ps"),
    readProcessTableSynchronously: () => [],
    processExists,
    workBuddyExecutablePaths: (environment) => {
        const paths = [join("/Applications", ...WORKBUDDY_MACOS_EXECUTABLE_PATH)];
        const homeDirectory = environment["HOME"];
        if (homeDirectory !== undefined && isAbsolute(homeDirectory)) {
            paths.unshift(join(homeDirectory, "Applications", ...WORKBUDDY_MACOS_EXECUTABLE_PATH));
        }
        return paths;
    },
    openCodeArchives: {
        arm64: {
            asset: "opencode-darwin-arm64.zip",
            sha256: "fe764f7f360c584a83e18dd5f23fb1a6b2725f5ee8854b0252fe558f7798e946",
            format: "zip",
        },
        x64: {
            asset: "opencode-darwin-x64.zip",
            sha256: "9858853e7bacdbbd22c2d70c377e009dc4b354dd04f5588705411e7afb89fd2d",
            format: "zip",
        },
    },
    grokDependencies: {
        arm64: {
            name: "@xai-official/grok-darwin-arm64",
            integrity:
                "sha512-I4pKZGnR6Mv4MJOJsB9B/i2o0ODF4eZtp4jHN5feoTqKIeAUVg38OzBtE8aN/wZa7Xg+qhnf6Jd1tcAFvMoFtQ==",
            tarballUrl: "https://registry.npmjs.org/@xai-official/grok-darwin-arm64/-/grok-darwin-arm64-1.0.21.tgz",
        },
        x64: {
            name: "@xai-official/grok-darwin-x64",
            integrity:
                "sha512-h0nFj3NZ9Kz8w6fQ6UDxxeSIhC1WjwwoRE92iNbG//tZy6YGkppR3s7oRVtt4Xl0CJANKUt0EusyIYnnAvKLzw==",
            tarballUrl: "https://registry.npmjs.org/@xai-official/grok-darwin-x64/-/grok-darwin-x64-1.0.21.tgz",
        },
    },
};
