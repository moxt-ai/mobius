import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEEPSEEK_HARNESS_PACKAGE } from "../../../packages/cli/src/agent-installation/deepseek-managed-package.ts";
import {
    type ManagedAgentArchiveDefinition,
    type ManagedAgentArchiveDownloadPort,
    ManagedAgentArchiveInstaller,
    TarGzipManagedAgentArchiveDefinition,
    validateManagedAgentArchive,
    ZipManagedAgentArchiveDefinition,
} from "../../../packages/cli/src/agent-installation/managed-agent-archive.ts";
import {
    ManagedNpmPackageInstaller,
    validateManagedNpmPackage,
} from "../../../packages/cli/src/agent-installation/managed-npm-package.ts";
import { VerifiedDownload } from "../../../packages/cli/src/agent-installation/verified-download.ts";
import { runBoundedProcess } from "../../../packages/cli/src/process/executable.ts";

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

class LocalArchiveDownloader implements ManagedAgentArchiveDownloadPort {
    readonly #archivePath: string;
    readonly #sha256: string;

    constructor(archivePath: string, sha256: string) {
        this.#archivePath = archivePath;
        this.#sha256 = sha256;
    }

    readonly download: ManagedAgentArchiveDownloadPort["download"] = async (options) => {
        options.signal.throwIfAborted();
        await copyFile(this.#archivePath, options.destination);
        const metadata = await stat(options.destination);
        return new VerifiedDownload(options.url, metadata.size, this.#sha256);
    };
}

describe("managed Agent artifacts", () => {
    it.skipIf(process.platform === "win32")(
        "Given the pinned DeepSeek Harness package needs platform binaries, When the production npm boundary installs it, Then optional dependencies are included while lifecycle scripts stay disabled",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-deepseek-npm-policy-"));
            const executableDirectory = join(temporaryDirectory, "bin");
            const npmPath = join(executableDirectory, "npm");
            const root = join(temporaryDirectory, "managed", DEEPSEEK_HARNESS_PACKAGE.version);
            try {
                await mkdir(executableDirectory, { mode: 0o700, recursive: true });
                await writeFile(
                    npmPath,
                    executableSource(`
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const arguments_ = process.argv.slice(2);
const prefixIndex = arguments_.indexOf("--prefix");
const prefix = arguments_[prefixIndex + 1];
if (prefixIndex < 0 || prefix === undefined) process.exit(81);
if (!arguments_.includes("--before=2026-09-23T00:00:00.000Z")) process.exit(82);
if (!arguments_.includes("--include=optional")) process.exit(83);
if (arguments_.includes("--omit=optional")) process.exit(84);
if (!arguments_.includes("--ignore-scripts")) process.exit(85);
if (process.env.NPM_CONFIG_INCLUDE !== "optional") process.exit(86);
if (process.env.NPM_CONFIG_OMIT !== undefined) process.exit(87);
if (process.env.NPM_CONFIG_IGNORE_SCRIPTS !== "true") process.exit(88);
const packageRoot = join(prefix, "node_modules", "@deepseek-ai", "dsh");
const executable = join(packageRoot, "lib", "bin.js");
mkdirSync(join(executable, ".."), { recursive: true });
writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
  bin: { dsh: "lib/bin.js" },
  name: "@deepseek-ai/dsh",
  version: ${JSON.stringify(DEEPSEEK_HARNESS_PACKAGE.version)},
}));
writeFileSync(executable, ${JSON.stringify(executableSource('process.stdout.write("managed-deepseek\\n");\n'))}, { mode: 0o700 });
chmodSync(executable, 0o700);
writeFileSync(join(prefix, "package-lock.json"), JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "node_modules/@deepseek-ai/dsh": {
      integrity: ${JSON.stringify(DEEPSEEK_HARNESS_PACKAGE.integrity)},
      resolved: ${JSON.stringify(DEEPSEEK_HARNESS_PACKAGE.tarballUrl)},
      version: ${JSON.stringify(DEEPSEEK_HARNESS_PACKAGE.version)},
    },
  },
}));
`),
                    { mode: 0o700 },
                );
                await chmod(npmPath, 0o700);

                const installed = await new ManagedNpmPackageInstaller().install(
                    root,
                    DEEPSEEK_HARNESS_PACKAGE,
                    { PATH: executableDirectory },
                    new AbortController().signal,
                );

                expect(installed.path).toBe(
                    await realpath(join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")),
                );
                await writeFile(
                    join(root, "package-lock.json"),
                    JSON.stringify({
                        lockfileVersion: 3,
                        packages: {
                            "node_modules/@deepseek-ai/dsh": {
                                integrity: DEEPSEEK_HARNESS_PACKAGE.integrity,
                                resolved: DEEPSEEK_HARNESS_PACKAGE.tarballUrl,
                                version: DEEPSEEK_HARNESS_PACKAGE.version,
                            },
                            "node_modules/unlocked-dependency": {
                                resolved:
                                    "https://registry.npmjs.org/unlocked-dependency/-/unlocked-dependency-1.0.0.tgz",
                                version: "1.0.0",
                            },
                        },
                    }),
                    { mode: 0o600 },
                );
                await expect(validateManagedNpmPackage(root, DEEPSEEK_HARNESS_PACKAGE)).rejects.toMatchObject({
                    code: "managed_package_verification_failed",
                });
            } finally {
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );

    it.runIf(process.platform === "darwin" || process.platform === "linux")(
        "Given a checksum-pinned Agent archive, When the managed archive boundary installs it, Then only the expected executable is atomically published and later tampering is rejected",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-managed-archive-"));
            try {
                const sourceDirectory = join(temporaryDirectory, "source");
                const sourceExecutable = join(sourceDirectory, "opencode");
                await mkdir(sourceDirectory, { mode: 0o700 });
                await writeFile(sourceExecutable, "#!/bin/sh\nprintf 'archive-test\\n'\n", { mode: 0o700 });
                await chmod(sourceExecutable, 0o700);
                const archivePath = join(
                    temporaryDirectory,
                    process.platform === "darwin" ? "opencode.zip" : "opencode.tar.gz",
                );
                if (process.platform === "darwin") {
                    await runBoundedProcess({
                        arguments: ["-q", archivePath, "opencode"],
                        command: "/usr/bin/zip",
                        cwd: sourceDirectory,
                        environment: { PATH: "/usr/bin:/bin" },
                        signal: new AbortController().signal,
                        timeoutMilliseconds: 10_000,
                    });
                } else {
                    await runBoundedProcess({
                        arguments: ["-czf", archivePath, "-C", sourceDirectory, "opencode"],
                        command: "/bin/tar",
                        cwd: temporaryDirectory,
                        environment: { PATH: "/usr/bin:/bin" },
                        signal: new AbortController().signal,
                        timeoutMilliseconds: 10_000,
                    });
                }
                const archiveBytes = await readFile(archivePath);
                const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
                let definition: ManagedAgentArchiveDefinition;
                if (process.platform === "darwin") {
                    definition = new ZipManagedAgentArchiveDefinition(
                        "test-version",
                        "opencode.zip",
                        new URL("https://github.com/example/opencode.zip"),
                        sha256,
                        "opencode",
                    );
                } else {
                    definition = new TarGzipManagedAgentArchiveDefinition(
                        "test-version",
                        "opencode.tar.gz",
                        new URL("https://github.com/example/opencode.tar.gz"),
                        sha256,
                        "opencode",
                    );
                }
                const root = join(temporaryDirectory, "managed", "test-version");
                const signal = new AbortController().signal;
                const installed = await new ManagedAgentArchiveInstaller(
                    new LocalArchiveDownloader(archivePath, sha256),
                ).install(root, definition, signal);

                expect(installed.path).toBe(await realpath(join(root, "bin", "opencode")));
                await expect(validateManagedAgentArchive(root, definition, signal)).resolves.toMatchObject({
                    path: installed.path,
                });
                await writeFile(installed.path, "tampered\n", { mode: 0o700 });
                await expect(validateManagedAgentArchive(root, definition, signal)).rejects.toMatchObject({
                    code: "managed_archive_verification_failed",
                });
            } finally {
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );
});
