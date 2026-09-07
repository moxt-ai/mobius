import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  findExecutableOnPath,
  type ResolvedExecutable,
  resolveExecutablePath,
  runBoundedProcess,
} from "../process/executable.ts";

const INSTALL_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const PACKAGE_METADATA_LIMIT_BYTES = 64 * 1024;
const PACKAGE_LOCK_LIMIT_BYTES = 8 * 1024 * 1024;

export class ManagedNpmPackageDefinition {
  readonly executableName: string;
  readonly packageName: string;
  readonly version: string;

  constructor(packageName: string, version: string, executableName: string) {
    this.executableName = executableName;
    this.packageName = packageName;
    this.version = version;
  }
}

export class SriManagedNpmPackageDefinition extends ManagedNpmPackageDefinition {
  readonly integrity: string;
  readonly tarballUrl: string;

  constructor(
    packageName: string,
    version: string,
    executableName: string,
    integrity: string,
    tarballUrl: string,
  ) {
    super(packageName, version, executableName);
    this.integrity = integrity;
    this.tarballUrl = tarballUrl;
  }
}

export class ManagedNpmPackageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "ManagedNpmPackageError";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packagePath(root: string, packageName: string): string {
  return join(root, "node_modules", ...packageName.split("/"));
}

function isContainedPath(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference.length > 0 &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

async function readJsonRecord(
  path: string,
  maximumBytes: number,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const handle = await open(path, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > maximumBytes) {
        throw new ManagedNpmPackageError(
          "managed_package_verification_failed",
          "The managed npm package metadata is invalid",
        );
      }
      const value: unknown = JSON.parse(
        await handle.readFile({ encoding: "utf8" }),
      );
      if (!isRecord(value)) {
        throw new ManagedNpmPackageError(
          "managed_package_verification_failed",
          "The managed npm package metadata is invalid",
        );
      }
      return value;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ManagedNpmPackageError) {
      throw error;
    }
    throw new ManagedNpmPackageError(
      "managed_package_verification_failed",
      "The managed npm package metadata is invalid",
      { cause: error },
    );
  }
}

function readBinPath(
  packageMetadata: Readonly<Record<string, unknown>>,
  executableName: string,
): string {
  const bin = packageMetadata["bin"];
  if (typeof bin === "string") {
    return bin;
  }
  if (isRecord(bin) && typeof bin[executableName] === "string") {
    return bin[executableName];
  }
  throw new ManagedNpmPackageError(
    "managed_package_verification_failed",
    "The managed npm package executable declaration is invalid",
  );
}

function verifyPackageLock(
  lock: Readonly<Record<string, unknown>>,
  definition: SriManagedNpmPackageDefinition,
): void {
  if (lock["lockfileVersion"] !== 3) {
    throw new ManagedNpmPackageError(
      "managed_package_verification_failed",
      "The managed npm package lockfile is invalid",
    );
  }
  const packages = lock["packages"];
  if (!isRecord(packages)) {
    throw new ManagedNpmPackageError(
      "managed_package_verification_failed",
      "The managed npm package lockfile is invalid",
    );
  }
  const suffix = `node_modules/${definition.packageName}`;
  let entry: unknown;
  let matches = 0;
  for (const [key, candidate] of Object.entries(packages)) {
    const normalizedKey = key.replaceAll("\\", "/");
    if (normalizedKey === suffix || normalizedKey.endsWith(`/${suffix}`)) {
      entry = candidate;
      matches += 1;
    }
  }
  if (
    matches !== 1 ||
    !isRecord(entry) ||
    entry["integrity"] !== definition.integrity ||
    entry["resolved"] !== definition.tarballUrl ||
    entry["version"] !== definition.version
  ) {
    throw new ManagedNpmPackageError(
      "managed_package_verification_failed",
      "The managed npm package lockfile does not match the pinned artifact",
    );
  }
}

export async function validateManagedNpmPackage(
  root: string,
  definition: ManagedNpmPackageDefinition,
): Promise<ResolvedExecutable> {
  try {
    return await validateManagedNpmPackageContents(root, definition);
  } catch (error) {
    if (error instanceof ManagedNpmPackageError) {
      throw error;
    }
    throw new ManagedNpmPackageError(
      "managed_package_verification_failed",
      "The managed npm package is invalid",
      { cause: error },
    );
  }
}

async function validateManagedNpmPackageContents(
  root: string,
  definition: ManagedNpmPackageDefinition,
): Promise<ResolvedExecutable> {
  const rootPath = await realpath(root);
  const packageRoot = await realpath(
    packagePath(rootPath, definition.packageName),
  );
  if (!isContainedPath(rootPath, packageRoot)) {
    throw new ManagedNpmPackageError(
      "managed_package_verification_failed",
      "The managed npm package escaped its private cache",
    );
  }
  const metadata = await readJsonRecord(
    join(packageRoot, "package.json"),
    PACKAGE_METADATA_LIMIT_BYTES,
  );
  if (
    metadata["name"] !== definition.packageName ||
    metadata["version"] !== definition.version
  ) {
    throw new ManagedNpmPackageError(
      "managed_package_verification_failed",
      "The managed npm package identity is invalid",
    );
  }
  if (definition instanceof SriManagedNpmPackageDefinition) {
    verifyPackageLock(
      await readJsonRecord(
        join(rootPath, "package-lock.json"),
        PACKAGE_LOCK_LIMIT_BYTES,
      ),
      definition,
    );
  }
  const declaredBin = readBinPath(metadata, definition.executableName);
  const executable = await resolveExecutablePath(
    join(packageRoot, declaredBin),
  );
  if (executable === null || !isContainedPath(rootPath, executable.path)) {
    throw new ManagedNpmPackageError(
      "managed_package_verification_failed",
      "The managed npm package executable is invalid",
    );
  }
  return executable;
}

export interface ManagedNpmPackageInstallationPort {
  readonly install: (
    root: string,
    definition: ManagedNpmPackageDefinition,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
  ) => Promise<ResolvedExecutable>;
}

export class ManagedNpmPackageInstaller
  implements ManagedNpmPackageInstallationPort
{
  readonly install = async (
    root: string,
    definition: ManagedNpmPackageDefinition,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
  ): Promise<ResolvedExecutable> => {
    signal.throwIfAborted();
    try {
      const metadata = await stat(root);
      if (metadata.isDirectory()) {
        return await validateManagedNpmPackage(root, definition);
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    const parent = dirname(root);
    await mkdir(parent, { mode: 0o700, recursive: true });
    const staging = await mkdtemp(
      join(parent, `.${definition.version}.staging-`),
    );
    try {
      const npm = await findExecutableOnPath(
        process.platform === "win32" ? "npm.cmd" : "npm",
        environment,
      );
      if (npm === null) {
        throw new ManagedNpmPackageError(
          "package_manager_not_found",
          "A supported npm executable is required to install the managed package",
        );
      }
      await runBoundedProcess({
        arguments: [
          "install",
          "--prefix",
          staging,
          "--omit=optional",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=true",
          "--save-exact",
          "--registry=https://registry.npmjs.org/",
          `${definition.packageName}@${definition.version}`,
        ],
        command: npm.path,
        cwd: staging,
        environment: {
          HOME: join(staging, "home"),
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_CACHE: join(staging, ".npm-cache"),
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          NPM_CONFIG_OMIT: "optional",
          NPM_CONFIG_PACKAGE_LOCK: "true",
          NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
          PATH: `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
        },
        outputLimitBytes: 64 * 1024,
        signal,
        timeoutMilliseconds: INSTALL_TIMEOUT_MILLISECONDS,
      });
      await Promise.all([
        rm(join(staging, ".npm-cache"), { force: true, recursive: true }),
        rm(join(staging, "home"), { force: true, recursive: true }),
      ]);
      await validateManagedNpmPackage(staging, definition);
      try {
        await rename(staging, root);
      } catch (error) {
        try {
          return await validateManagedNpmPackage(root, definition);
        } catch {
          throw new ManagedNpmPackageError(
            "managed_package_publish_failed",
            "The managed npm package could not be published",
            { cause: error },
          );
        }
      }
      return await validateManagedNpmPackage(root, definition);
    } catch (error) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (error instanceof ManagedNpmPackageError) {
        throw error;
      }
      throw new ManagedNpmPackageError(
        "managed_package_install_failed",
        "The pinned npm package could not be installed",
        { cause: error },
      );
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  };
}
