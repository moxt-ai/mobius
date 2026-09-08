import { SriManagedNpmDependencyDefinition, SriManagedNpmPackageDefinition } from "./managed-npm-package.ts";

export const GROK_BUILD_MANAGED_VERSION = "1.0.21";

class GrokBuildManagedPackage extends SriManagedNpmPackageDefinition {
    override readonly dependencyResolutionArguments = Object.freeze(["--before=2026-09-04T19:51:47.325Z"]);
    override readonly includeOptionalDependencies = true;
    override readonly requiredDependencies: readonly SriManagedNpmDependencyDefinition[];
    override readonly verifyDependencyClosure = true;

    constructor(requiredDependency: SriManagedNpmDependencyDefinition) {
        super(
            "@xai-official/grok",
            GROK_BUILD_MANAGED_VERSION,
            "grok",
            "sha512-6yQqC+h1o+ObaqCxImK23dhkrOX1DEBMOKaH6fCK+B4gX0/8XIKZp0n7iKyBdK8KZa5vhMn7pS45kjX49Tps5g==",
            "https://registry.npmjs.org/@xai-official/grok/-/grok-1.0.21.tgz",
        );
        this.requiredDependencies = Object.freeze([requiredDependency]);
    }
}

const GROK_DARWIN_ARM64_PACKAGE = new SriManagedNpmDependencyDefinition(
    "@xai-official/grok-darwin-arm64",
    GROK_BUILD_MANAGED_VERSION,
    "sha512-I4pKZGnR6Mv4MJOJsB9B/i2o0ODF4eZtp4jHN5feoTqKIeAUVg38OzBtE8aN/wZa7Xg+qhnf6Jd1tcAFvMoFtQ==",
    "https://registry.npmjs.org/@xai-official/grok-darwin-arm64/-/grok-darwin-arm64-1.0.21.tgz",
);

const GROK_DARWIN_X64_PACKAGE = new SriManagedNpmDependencyDefinition(
    "@xai-official/grok-darwin-x64",
    GROK_BUILD_MANAGED_VERSION,
    "sha512-h0nFj3NZ9Kz8w6fQ6UDxxeSIhC1WjwwoRE92iNbG//tZy6YGkppR3s7oRVtt4Xl0CJANKUt0EusyIYnnAvKLzw==",
    "https://registry.npmjs.org/@xai-official/grok-darwin-x64/-/grok-darwin-x64-1.0.21.tgz",
);

const GROK_LINUX_ARM64_PACKAGE = new SriManagedNpmDependencyDefinition(
    "@xai-official/grok-linux-arm64",
    GROK_BUILD_MANAGED_VERSION,
    "sha512-Jlwz9XtZPNKz/V/ydifC8OVu3hIZz7pmoStt8c4KCqkSWjWiZ/PBIC0iJiq8rvByhx5Z0EdSyq8ZXVwtocceGA==",
    "https://registry.npmjs.org/@xai-official/grok-linux-arm64/-/grok-linux-arm64-1.0.21.tgz",
);

const GROK_LINUX_X64_PACKAGE = new SriManagedNpmDependencyDefinition(
    "@xai-official/grok-linux-x64",
    GROK_BUILD_MANAGED_VERSION,
    "sha512-AjDV5ifEz5LFG2Jt5IlhAeEkJati/wOvCchVbR4eIj2ogjvmXoXlzBrYRXuAJpXBy5q0se/Yuez5FxDU9Ju81w==",
    "https://registry.npmjs.org/@xai-official/grok-linux-x64/-/grok-linux-x64-1.0.21.tgz",
);

export function grokBuildManagedPackage(
    platform: NodeJS.Platform,
    architecture: NodeJS.Architecture,
): SriManagedNpmPackageDefinition {
    if (platform === "darwin" && architecture === "arm64") {
        return new GrokBuildManagedPackage(GROK_DARWIN_ARM64_PACKAGE);
    }
    if (platform === "darwin" && architecture === "x64") {
        return new GrokBuildManagedPackage(GROK_DARWIN_X64_PACKAGE);
    }
    if (platform === "linux" && architecture === "arm64") {
        return new GrokBuildManagedPackage(GROK_LINUX_ARM64_PACKAGE);
    }
    if (platform === "linux" && architecture === "x64") {
        return new GrokBuildManagedPackage(GROK_LINUX_X64_PACKAGE);
    }
    throw new Error("Grok Build does not publish a package for this platform");
}
