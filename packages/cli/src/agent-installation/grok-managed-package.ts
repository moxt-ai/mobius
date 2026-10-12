import { platformSupportFor } from "../platform/index.ts";
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

export function grokBuildManagedPackage(
    platform: NodeJS.Platform,
    architecture: NodeJS.Architecture,
): SriManagedNpmPackageDefinition {
    const release = platformSupportFor(platform).grokDependencies[architecture];
    if (release === undefined) {
        throw new Error("Grok Build does not publish a package for this platform");
    }
    return new GrokBuildManagedPackage(
        new SriManagedNpmDependencyDefinition(
            release.name,
            GROK_BUILD_MANAGED_VERSION,
            release.integrity,
            release.tarballUrl,
        ),
    );
}
