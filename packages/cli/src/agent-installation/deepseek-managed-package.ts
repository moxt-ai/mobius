import { SriManagedNpmPackageDefinition } from "./managed-npm-package.ts";

class DeepSeekHarnessManagedPackage extends SriManagedNpmPackageDefinition {
    override readonly dependencyResolutionArguments = Object.freeze(["--before=2026-09-23T00:00:00.000Z"]);
    override readonly includeOptionalDependencies = true;
    override readonly verifyDependencyClosure = true;
}

// Keep the managed release aligned with the real ACP integration test; 0.1.5-rc.2 fails to load its sandbox plugin.
export const DEEPSEEK_HARNESS_PACKAGE = new DeepSeekHarnessManagedPackage(
    "@deepseek-ai/dsh",
    "0.1.5-rc.3",
    "dsh",
    "sha512-c0W6Xqc4ChjFcCJkbzPeIxZQdnbKqe+QAcJzWGtogg0ZzsnZRcw3vopMyZ5oZU6E2fmyqGcyDR1sBeiCH4yHcg==",
    "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.3.tgz",
);
