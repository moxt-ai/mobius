import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { delimiter, dirname, join, relative } from "node:path";

import type { LocalAgentSpecification } from "../agent-catalog/discover-local-agents.ts";
import {
  findExecutableOnPath,
  type ResolvedExecutable,
  resolveExecutablePath,
  runBoundedProcess,
} from "../process/executable.ts";

const ADAPTER_INSTALL_TIMEOUT_MILLISECONDS = 2 * 60 * 1_000;
const PACKAGE_METADATA_LIMIT_BYTES = 64 * 1024;

export class ManagedAdapterInstallError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "ManagedAdapterInstallError";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packagePath(root: string, packageName: string): string {
  return join(root, "node_modules", ...packageName.split("/"));
}

async function readPackageJson(
  path: string,
): Promise<Readonly<Record<string, unknown>>> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > PACKAGE_METADATA_LIMIT_BYTES) {
      throw new ManagedAdapterInstallError(
        "adapter_verification_failed",
        "The managed adapter package metadata is invalid",
      );
    }
    const value: unknown = JSON.parse(
      await handle.readFile({ encoding: "utf8" }),
    );
    if (!isRecord(value)) {
      throw new ManagedAdapterInstallError(
        "adapter_verification_failed",
        "The managed adapter package metadata is invalid",
      );
    }
    return value;
  } finally {
    await handle.close();
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
  throw new ManagedAdapterInstallError(
    "adapter_verification_failed",
    "The managed adapter executable declaration is invalid",
  );
}

export async function validateManagedAdapter(
  root: string,
  specification: LocalAgentSpecification,
): Promise<ResolvedExecutable> {
  const rootPath = await realpath(root);
  const packageRoot = await realpath(
    packagePath(rootPath, specification.adapterPackage),
  );
  const packageDifference = relative(rootPath, packageRoot);
  if (packageDifference.startsWith("..") || packageDifference.length === 0) {
    throw new ManagedAdapterInstallError(
      "adapter_verification_failed",
      "The managed adapter package escaped its private cache",
    );
  }
  const metadata = await readPackageJson(join(packageRoot, "package.json"));
  if (
    metadata["name"] !== specification.adapterPackage ||
    metadata["version"] !== specification.adapterVersion
  ) {
    throw new ManagedAdapterInstallError(
      "adapter_verification_failed",
      "The managed adapter package identity is invalid",
    );
  }
  const declaredBin = readBinPath(metadata, specification.adapterExecutable);
  const executable = await resolveExecutablePath(
    join(packageRoot, declaredBin),
  );
  if (executable === null) {
    throw new ManagedAdapterInstallError(
      "adapter_verification_failed",
      "The managed adapter executable is invalid",
    );
  }
  const executableDifference = relative(rootPath, executable.path);
  if (
    executableDifference.startsWith("..") ||
    executableDifference.length === 0
  ) {
    throw new ManagedAdapterInstallError(
      "adapter_verification_failed",
      "The managed adapter executable escaped its private cache",
    );
  }
  return executable;
}

export interface ManagedAdapterInstallerOptions {
  readonly approvedRoot: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly stateDirectory: string;
}

export interface AdapterInstallationPort {
  readonly install: (
    specification: LocalAgentSpecification,
    signal: AbortSignal,
  ) => Promise<ResolvedExecutable>;
}

export class ManagedAdapterInstaller implements AdapterInstallationPort {
  readonly #approvedRoot: string;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #stateDirectory: string;

  constructor(options: ManagedAdapterInstallerOptions) {
    this.#approvedRoot = options.approvedRoot;
    this.#environment = options.environment;
    this.#stateDirectory = options.stateDirectory;
  }

  readonly install = async (
    specification: LocalAgentSpecification,
    signal: AbortSignal,
  ): Promise<ResolvedExecutable> => {
    signal.throwIfAborted();
    const agentCache = join(this.#stateDirectory, "adapters", specification.id);
    const published = join(agentCache, specification.adapterVersion);
    try {
      const metadata = await stat(published);
      if (metadata.isDirectory()) {
        return await validateManagedAdapter(published, specification);
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

    await mkdir(agentCache, { mode: 0o700, recursive: true });
    const staging = await mkdtemp(
      join(agentCache, `.${specification.adapterVersion}.staging-`),
    );
    try {
      const npm = await findExecutableOnPath(
        process.platform === "win32" ? "npm.cmd" : "npm",
        this.#environment,
        this.#approvedRoot,
      );
      if (npm === null) {
        throw new ManagedAdapterInstallError(
          "package_manager_not_found",
          "A supported npm executable is required to install the ACP adapter",
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
          "--package-lock=false",
          "--save=false",
          "--registry=https://registry.npmjs.org/",
          `${specification.adapterPackage}@${specification.adapterVersion}`,
        ],
        command: npm.path,
        cwd: staging,
        environment: {
          HOME: join(staging, "home"),
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
          NPM_CONFIG_OMIT: "optional",
          NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
          PATH: `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
        },
        outputLimitBytes: 64 * 1024,
        signal,
        timeoutMilliseconds: ADAPTER_INSTALL_TIMEOUT_MILLISECONDS,
      });
      await validateManagedAdapter(staging, specification);
      try {
        await rename(staging, published);
      } catch (error) {
        try {
          return await validateManagedAdapter(published, specification);
        } catch {
          throw new ManagedAdapterInstallError(
            "adapter_publish_failed",
            "The managed adapter could not be published",
            { cause: error },
          );
        }
      }
      return await validateManagedAdapter(published, specification);
    } catch (error) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      if (error instanceof ManagedAdapterInstallError) {
        throw error;
      }
      throw new ManagedAdapterInstallError(
        "adapter_install_failed",
        "The pinned ACP adapter could not be installed",
        { cause: error },
      );
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  };
}
