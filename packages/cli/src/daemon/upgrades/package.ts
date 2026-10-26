import { isAbsolute, join, relative } from "node:path";
import { runtimeUpgradeVersionSchema } from "@moxt-ai/mobius-sdk/protocol";
import { gt, satisfies, validRange } from "semver";
import { z } from "zod";
import { readInstalledRelease, releasePrefix } from "../../storage/daemon/release-files.ts";
import { canonicalPath, ensurePrivateDirectory } from "../../storage/files/local-files.ts";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import { findExecutableOnPath, runBoundedProcess } from "../../util/process/executable.ts";
import type { WorkerLaunch } from "../control/protocol.ts";
import { decodeWorkerLaunch } from "../lifecycle/worker-process.ts";

export class DaemonReleaseUpgradeError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
    }
}

interface InstalledReleaseEntry {
    readonly entry: string;
    readonly nodeRange: string;
}

// The entry of the release npm installed into `prefix`, once its manifest names exactly `version`
// and the entry stays inside the prefix.
async function readReleaseEntry(prefix: string, version: string): Promise<InstalledReleaseEntry> {
    const installed = await readInstalledRelease(prefix);
    const metadata = z
        .object({
            name: z.literal("@moxt-ai/mobius"),
            version: z.literal(version),
            bin: z.object({ mobius: z.literal("dist/cli.js") }),
            engines: z.object({ node: z.string().refine((value) => validRange(value) !== null) }),
        })
        .parse(JSON.parse(installed.manifest));
    const entry = await canonicalPath(join(installed.packageRoot, metadata.bin.mobius));
    const resolved = relative(await canonicalPath(prefix), entry);
    if (resolved.startsWith("..") || isAbsolute(resolved)) {
        throw new Error("Installed entry escaped npm prefix");
    }
    return { entry, nodeRange: metadata.engines.node };
}

// Run the release with the worker's actual executable before trusting it.
// An engines declaration alone cannot detect unsupported syntax or missing dependencies.
async function smokeTestRelease(entry: string, prefix: string, version: string, signal: AbortSignal): Promise<void> {
    try {
        const result = await runBoundedProcess({
            command: process.execPath,
            arguments: [entry, "--version"],
            cwd: prefix,
            environment: process.env,
            signal,
            timeoutMilliseconds: 30_000,
            outputLimitBytes: 16 * 1024,
        });
        if (!result.stdout.split(/\r?\n/u).includes(`CLI: ${version}`)) {
            throw new Error("Candidate did not report the requested CLI version");
        }
    } catch (cause) {
        signal.throwIfAborted();
        throw new DaemonReleaseUpgradeError(
            "release_startup_failed",
            `Mobius ${version} startup check failed; the current daemon is unchanged.`,
            { cause },
        );
    }
}

/**
 * The launch of the release npm already installed for `version`, or null when its prefix does not hold a
 * release of exactly that version that starts. A null tells the caller to install the release again.
 */
export async function readInstalledDaemonRelease(version: string, signal: AbortSignal): Promise<WorkerLaunch | null> {
    runtimeUpgradeVersionSchema.parse(version);
    const prefix = releasePrefix(version);
    try {
        await validateLocalPath(prefix, true, true, signal);
        const { entry } = await readReleaseEntry(prefix, version);
        await smokeTestRelease(entry, prefix, version, signal);
        return await decodeWorkerLaunch({ executable: process.execPath, entry, version });
    } catch {
        signal.throwIfAborted();
        // Absent, partial or foreign.
        return null;
    }
}

export async function installDaemonReleaseVersion(version: string, signal: AbortSignal): Promise<WorkerLaunch> {
    runtimeUpgradeVersionSchema.parse(version);
    const npm = await findExecutableOnPath("npm", process.env);
    if (npm === null) {
        throw new DaemonReleaseUpgradeError("npm_unavailable", "npm is required to download the new daemon");
    }
    // npm owns the package installation; never overwrite the running release.
    const prefix = releasePrefix(version);
    await ensurePrivateDirectory(prefix);
    try {
        await validateLocalPath(prefix, true, true, signal);
        await runBoundedProcess({
            command: npm.path,
            arguments: [
                "install",
                "--prefix",
                prefix,
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--save-exact",
                "--",
                `@moxt-ai/mobius@${version}`,
            ],
            cwd: prefix,
            environment: process.env,
            signal,
            timeoutMilliseconds: 300_000,
            outputLimitBytes: 64 * 1024,
        });
        const { entry, nodeRange } = await readReleaseEntry(prefix, version);
        if (!satisfies(process.versions.node, nodeRange)) {
            throw new DaemonReleaseUpgradeError(
                "node_incompatible",
                `Mobius ${version} requires Node.js ${nodeRange}; the running daemon uses ${process.versions.node} at ${process.execPath}. Update Node.js before retrying.`,
            );
        }
        // Check before requesting any switch.
        await smokeTestRelease(entry, prefix, version, signal);
        return await decodeWorkerLaunch({ executable: process.execPath, entry, version });
    } catch (cause) {
        signal.throwIfAborted();
        if (cause instanceof DaemonReleaseUpgradeError) {
            throw cause;
        }
        throw new DaemonReleaseUpgradeError(
            "npm_install_failed",
            "npm could not install and verify the requested Mobius version",
            { cause },
        );
    }
}

// `npm view <package> <field> --json` prints the field's value through npm 11 and
// a one-element array from npm 12. Accept exactly those shapes; anything else is
// not a version npm reported.
const npmViewVersionSchema = z
    .union([runtimeUpgradeVersionSchema, z.tuple([runtimeUpgradeVersionSchema])])
    .transform((value) => (typeof value === "string" ? value : value[0]));

export async function findNewDaemonReleaseVersion(currentVersion: string, signal: AbortSignal): Promise<string | null> {
    const npm = await findExecutableOnPath("npm", process.env);
    if (npm === null) {
        throw new DaemonReleaseUpgradeError("npm_unavailable", "npm is required to check for a new daemon");
    }
    try {
        const result = await runBoundedProcess({
            command: npm.path,
            arguments: ["view", "@moxt-ai/mobius", "dist-tags.latest", "--json", "--prefer-online"],
            cwd: process.cwd(),
            environment: process.env,
            signal,
            timeoutMilliseconds: 30_000,
            outputLimitBytes: 4096,
        });
        const version = npmViewVersionSchema.parse(JSON.parse(result.stdout));
        return gt(version, currentVersion) ? version : null;
    } catch (cause) {
        signal.throwIfAborted();
        throw new DaemonReleaseUpgradeError("npm_check_failed", "npm could not return a valid latest Mobius version", {
            cause,
        });
    }
}
