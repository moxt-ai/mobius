import { SriManagedNpmPackageDefinition } from "./managed-npm-package.ts";

export const WORKBUDDY_MANAGED_VERSION = "2.146.0";

class WorkBuddyManagedPackage extends SriManagedNpmPackageDefinition {
  override readonly dependencyResolutionArguments = Object.freeze([
    "--before=2026-09-05T12:39:25.295Z",
  ]);
  override readonly includeOptionalDependencies = true;
  override readonly verifyDependencyClosure = true;
}

export const WORKBUDDY_MANAGED_PACKAGE = new WorkBuddyManagedPackage(
  "@tencent-ai/codebuddy-code",
  WORKBUDDY_MANAGED_VERSION,
  "codebuddy",
  "sha512-81V+8rzYJY8PezHZMs4VZN2nvoijrsRWIuCERTr6hELotcxaZaAcqbQQSbHJcN8eTlFE5TRPlzMI4oEkLCat4A==",
  "https://registry.npmjs.org/@tencent-ai/codebuddy-code/-/codebuddy-code-2.146.0.tgz",
);
