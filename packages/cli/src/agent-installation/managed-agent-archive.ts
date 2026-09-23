import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

import {
    type ResolvedExecutable,
    resolveExecutablePath,
    revalidateExecutable,
    runBoundedProcess,
} from "../process/executable.ts";
import { downloadVerifiedFile, type VerifiedDownload, type VerifiedDownloadOptions } from "./verified-download.ts";

const ARCHIVE_DOWNLOAD_LIMIT_BYTES = 128 * 1024 * 1024;
const ARCHIVE_DOWNLOAD_TIMEOUT_MILLISECONDS = 2 * 60 * 1_000;
const ARCHIVE_EXTRACTION_TIMEOUT_MILLISECONDS = 60_000;
const MANIFEST_LIMIT_BYTES = 16 * 1024;
const MINIMAL_PATH = "/usr/bin:/bin";

export abstract class ManagedAgentArchiveDefinition {
    readonly archiveName: string;
    readonly archiveSha256: string;
    readonly archiveUrl: URL;
    readonly executableName: string;
    readonly version: string;
    abstract readonly extractArguments: (archivePath: string, destination: string) => readonly string[];
    abstract readonly extractorPaths: readonly string[];
    abstract readonly listArguments: (archivePath: string) => readonly string[];

    constructor(version: string, archiveName: string, archiveUrl: URL, archiveSha256: string, executableName: string) {
        this.archiveName = archiveName;
        this.archiveSha256 = archiveSha256;
        this.archiveUrl = new URL(archiveUrl);
        this.executableName = executableName;
        this.version = version;
    }
}

export class ZipManagedAgentArchiveDefinition extends ManagedAgentArchiveDefinition {
    readonly extractorPaths = Object.freeze(["/usr/bin/unzip", "/bin/unzip", "/run/current-system/sw/bin/unzip"]);
    readonly extractArguments = (archivePath: string, destination: string): readonly string[] => [
        "-q",
        archivePath,
        "-d",
        destination,
    ];
    readonly listArguments = (archivePath: string): readonly string[] => ["-Z1", archivePath];
}

export class TarGzipManagedAgentArchiveDefinition extends ManagedAgentArchiveDefinition {
    readonly extractorPaths = Object.freeze(["/usr/bin/tar", "/bin/tar", "/run/current-system/sw/bin/tar"]);
    readonly extractArguments = (archivePath: string, destination: string): readonly string[] => [
        "-xzf",
        archivePath,
        "-C",
        destination,
    ];
    readonly listArguments = (archivePath: string): readonly string[] => ["-tzf", archivePath];
}

class ManagedAgentArchiveError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ManagedAgentArchiveError";
    }
}

export interface ManagedAgentArchiveDownloadPort {
    readonly download: (options: VerifiedDownloadOptions) => Promise<VerifiedDownload>;
}

class ManagedAgentArchiveDownloader implements ManagedAgentArchiveDownloadPort {
    readonly download = async (options: VerifiedDownloadOptions): Promise<VerifiedDownload> =>
        await downloadVerifiedFile(options);
}

interface ManagedAgentArchiveInstallationPort {
    readonly install: (
        root: string,
        definition: ManagedAgentArchiveDefinition,
        signal: AbortSignal,
    ) => Promise<ResolvedExecutable>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContainedPath(root: string, candidate: string): boolean {
    const difference = relative(root, candidate);
    return (
        difference.length > 0 && difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
    );
}

async function hashFile(path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const digest = createHash("sha256");
    const stream = createReadStream(path, { signal });
    try {
        for await (const chunk of stream) {
            signal.throwIfAborted();
            if (!(chunk instanceof Uint8Array)) {
                throw new ManagedAgentArchiveError(
                    "managed_archive_verification_failed",
                    "The managed Agent archive produced invalid bytes",
                );
            }
            digest.update(chunk);
        }
        return digest.digest("hex");
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        if (error instanceof ManagedAgentArchiveError) {
            throw error;
        }
        throw new ManagedAgentArchiveError(
            "managed_archive_verification_failed",
            "The managed Agent artifact could not be verified",
            { cause: error },
        );
    }
}

async function readManifest(path: string): Promise<Readonly<Record<string, unknown>>> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
        handle = await open(path, "r");
    } catch (error) {
        throw new ManagedAgentArchiveError(
            "managed_archive_verification_failed",
            "The managed Agent archive manifest is invalid",
            { cause: error },
        );
    }
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MANIFEST_LIMIT_BYTES) {
            throw new ManagedAgentArchiveError(
                "managed_archive_verification_failed",
                "The managed Agent archive manifest is invalid",
            );
        }
        const parsed: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
        if (!isRecord(parsed)) {
            throw new ManagedAgentArchiveError(
                "managed_archive_verification_failed",
                "The managed Agent archive manifest is invalid",
            );
        }
        return parsed;
    } catch (error) {
        if (error instanceof ManagedAgentArchiveError) {
            throw error;
        }
        throw new ManagedAgentArchiveError(
            "managed_archive_verification_failed",
            "The managed Agent archive manifest is invalid",
            { cause: error },
        );
    } finally {
        await handle.close();
    }
}

export async function validateManagedAgentArchive(
    root: string,
    definition: ManagedAgentArchiveDefinition,
    signal: AbortSignal,
): Promise<ResolvedExecutable> {
    try {
        const rootPath = await realpath(root);
        const rootMetadata = await stat(rootPath);
        if (
            !rootMetadata.isDirectory() ||
            (typeof process.getuid === "function" && rootMetadata.uid !== process.getuid())
        ) {
            throw new Error("Managed Agent root is not user-owned");
        }
        const manifest = await readManifest(join(rootPath, "archive.json"));
        if (
            manifest["archiveSha256"] !== definition.archiveSha256 ||
            manifest["archiveUrl"] !== definition.archiveUrl.toString() ||
            manifest["version"] !== definition.version ||
            typeof manifest["executableSha256"] !== "string"
        ) {
            throw new Error("Managed Agent archive identity is invalid");
        }
        const executable = await resolveExecutablePath(join(rootPath, "bin", definition.executableName));
        if (
            executable === null ||
            !isContainedPath(rootPath, executable.path) ||
            (await hashFile(executable.path, signal)) !== manifest["executableSha256"]
        ) {
            throw new Error("Managed Agent executable is invalid");
        }
        return executable;
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        if (error instanceof ManagedAgentArchiveError) {
            throw error;
        }
        throw new ManagedAgentArchiveError(
            "managed_archive_verification_failed",
            "The managed Agent archive did not match its pinned artifact",
            { cause: error },
        );
    }
}

function validateArchiveEntries(output: string, definition: ManagedAgentArchiveDefinition): void {
    const entries = output
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (
        entries.length !== 1 ||
        (entries[0] !== definition.executableName && entries[0] !== `./${definition.executableName}`)
    ) {
        throw new ManagedAgentArchiveError(
            "managed_archive_verification_failed",
            "The managed Agent archive contains unexpected entries",
        );
    }
}

async function resolveArchiveExtractor(
    definition: ManagedAgentArchiveDefinition,
    signal: AbortSignal,
): Promise<ResolvedExecutable> {
    for (const requestedPath of definition.extractorPaths) {
        signal.throwIfAborted();
        const executable = await resolveExecutablePath(requestedPath);
        if (executable !== null) {
            return executable;
        }
    }
    throw new ManagedAgentArchiveError(
        "managed_archive_extractor_not_found",
        "A supported local archive extractor is required to install this Agent",
    );
}

async function assertArchiveExtractorUnchanged(extractor: ResolvedExecutable): Promise<void> {
    if (!(await revalidateExecutable(extractor.identity))) {
        throw new ManagedAgentArchiveError(
            "managed_archive_extractor_changed",
            "The local archive extractor changed during installation",
        );
    }
}

export class ManagedAgentArchiveInstaller implements ManagedAgentArchiveInstallationPort {
    readonly #downloader: ManagedAgentArchiveDownloadPort;

    constructor(downloader: ManagedAgentArchiveDownloadPort = new ManagedAgentArchiveDownloader()) {
        this.#downloader = downloader;
    }

    readonly install = async (
        root: string,
        definition: ManagedAgentArchiveDefinition,
        signal: AbortSignal,
    ): Promise<ResolvedExecutable> => {
        signal.throwIfAborted();
        try {
            const metadata = await stat(root);
            if (metadata.isDirectory()) {
                return await validateManagedAgentArchive(root, definition, signal);
            }
        } catch (error) {
            if (
                error instanceof ManagedAgentArchiveError ||
                !(error instanceof Error) ||
                !("code" in error) ||
                error.code !== "ENOENT"
            ) {
                throw error;
            }
        }

        const parent = dirname(root);
        await mkdir(parent, { mode: 0o700, recursive: true });
        const working = await mkdtemp(join(parent, `.${definition.version}.archive-`));
        const staging = await mkdtemp(join(parent, `.${definition.version}.staging-`));
        try {
            const extractor = await resolveArchiveExtractor(definition, signal);
            const extractorEnvironment = {
                PATH: `${dirname(extractor.identity.requestedPath)}${delimiter}${MINIMAL_PATH}`,
            };
            const archivePath = join(working, definition.archiveName);
            const extractionRoot = join(working, "extracted");
            await mkdir(extractionRoot, { mode: 0o700 });
            const canonicalExtractionRoot = await realpath(extractionRoot);
            const download = await this.#downloader.download({
                allowedHosts: new Set([
                    "github.com",
                    "objects.githubusercontent.com",
                    "release-assets.githubusercontent.com",
                ]),
                destination: archivePath,
                maximumBytes: ARCHIVE_DOWNLOAD_LIMIT_BYTES,
                signal,
                timeoutMilliseconds: ARCHIVE_DOWNLOAD_TIMEOUT_MILLISECONDS,
                url: definition.archiveUrl,
            });
            if (download.sha256 !== definition.archiveSha256) {
                throw new ManagedAgentArchiveError(
                    "managed_archive_verification_failed",
                    "The managed Agent archive checksum is invalid",
                );
            }
            await assertArchiveExtractorUnchanged(extractor);
            const list = await runBoundedProcess({
                arguments: definition.listArguments(archivePath),
                command: extractor.identity.requestedPath,
                cwd: working,
                environment: extractorEnvironment,
                outputLimitBytes: 64 * 1024,
                signal,
                timeoutMilliseconds: ARCHIVE_EXTRACTION_TIMEOUT_MILLISECONDS,
            });
            validateArchiveEntries(list.stdout, definition);
            await assertArchiveExtractorUnchanged(extractor);
            await runBoundedProcess({
                arguments: definition.extractArguments(archivePath, extractionRoot),
                command: extractor.identity.requestedPath,
                cwd: working,
                environment: extractorEnvironment,
                outputLimitBytes: 64 * 1024,
                signal,
                timeoutMilliseconds: ARCHIVE_EXTRACTION_TIMEOUT_MILLISECONDS,
            });
            const extracted = await realpath(join(canonicalExtractionRoot, definition.executableName));
            const extractedMetadata = await stat(extracted);
            if (!isContainedPath(canonicalExtractionRoot, extracted) || !extractedMetadata.isFile()) {
                throw new ManagedAgentArchiveError(
                    "managed_archive_verification_failed",
                    "The managed Agent archive executable is invalid",
                );
            }
            const binDirectory = join(staging, "bin");
            const executablePath = join(binDirectory, definition.executableName);
            await mkdir(binDirectory, { mode: 0o700 });
            await copyFile(extracted, executablePath);
            await chmod(executablePath, 0o700);
            const executableSha256 = await hashFile(executablePath, signal);
            await writeFile(
                join(staging, "archive.json"),
                `${JSON.stringify({
                    archiveSha256: definition.archiveSha256,
                    archiveUrl: definition.archiveUrl.toString(),
                    executableSha256,
                    version: definition.version,
                })}\n`,
                { mode: 0o600 },
            );
            await validateManagedAgentArchive(staging, definition, signal);
            try {
                await rename(staging, root);
            } catch (error) {
                try {
                    return await validateManagedAgentArchive(root, definition, signal);
                } catch {
                    throw new ManagedAgentArchiveError(
                        "managed_archive_publish_failed",
                        "The managed Agent archive could not be published",
                        { cause: error },
                    );
                }
            }
            return await validateManagedAgentArchive(root, definition, signal);
        } catch (error) {
            if (signal.aborted) {
                signal.throwIfAborted();
            }
            if (error instanceof ManagedAgentArchiveError) {
                throw error;
            }
            throw new ManagedAgentArchiveError(
                "managed_archive_install_failed",
                "The pinned Agent archive could not be installed",
                { cause: error },
            );
        } finally {
            await Promise.all([
                rm(working, { force: true, recursive: true }),
                rm(staging, { force: true, recursive: true }),
            ]);
        }
    };
}
