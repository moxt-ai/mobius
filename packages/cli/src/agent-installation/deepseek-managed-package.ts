import { SriManagedNpmPackageDefinition } from "./managed-npm-package.ts";

class DeepSeekHarnessManagedPackage extends SriManagedNpmPackageDefinition {
    override readonly dependencyResolutionArguments = Object.freeze(["--before=2026-09-18T00:00:00.000Z"]);
    override readonly includeOptionalDependencies = true;
    override readonly verifyDependencyClosure = true;
}

export const DEEPSEEK_HARNESS_PACKAGE = new DeepSeekHarnessManagedPackage(
    "@deepseek-ai/dsh",
    "0.1.5-rc.2",
    "dsh",
    "sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==",
    "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz",
);
