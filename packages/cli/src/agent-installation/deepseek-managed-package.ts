import { SriManagedNpmPackageDefinition } from "./managed-npm-package.ts";

class DeepSeekHarnessManagedPackage extends SriManagedNpmPackageDefinition {
    override readonly dependencyResolutionArguments = Object.freeze(["--before=2026-09-03T06:31:52.107Z"]);
    override readonly includeOptionalDependencies = true;
    override readonly verifyDependencyClosure = true;
}

export const DEEPSEEK_HARNESS_PACKAGE = new DeepSeekHarnessManagedPackage(
    "@deepseek-ai/dsh",
    "0.1.2-rc.1",
    "dsh",
    "sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA==",
    "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz",
);
