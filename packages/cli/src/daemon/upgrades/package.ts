import { isAbsolute, join, relative } from "node:path";
import { decodeRuntimeUpgradeVersion } from "@moxt-ai/mobius-sdk/protocol";
import { gt, satisfies, validRange } from "semver";
import { z } from "zod";
import { canonicalPath, ensurePrivateDirectory } from "../../engine/storage/files/local-files.ts";
import { validateLocalPath } from "../../engine/util/filesystem/private-path.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { findExecutableOnPath, runBoundedProcess } from "../../engine/util/process/executable.ts";
import { type InstalledRelease, readInstalledRelease, releasePrefix } from "../../storage/daemon/release-files.ts";
import type { WorkerLaunch } from "../control/protocol.ts";
import { decodeWorkerLaunch } from "../lifecycle/worker-process.ts";

export class DaemonReleaseUpgradeError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
    }
}

export async function prepareDaemonReleaseVersion(version: string, signal: AbortSignal): Promise<WorkerLaunch> {
    decodeRuntimeUpgradeVersion(version);
    signal.throwIfAborted();
    const prefix = releasePrefix(version);
    let installed: InstalledRelease;
    try {
        installed = await readInstalledRelease(prefix);
    } catch (cause) {
        signal.throwIfAborted();
        if (!isNodeError(cause, "ENOENT")) {
            throw new DaemonReleaseUpgradeError(
                "release_read_failed",
                "The installed Mobius release could not be read",
                { cause },
            );
        }
        return await installDaemonReleaseVersion(version, signal);
    }
    try {
        return await verifyInstalledDaemonRelease(installed, prefix, version, signal);
    } catch (cause) {
        signal.throwIfAborted();
        if (cause instanceof DaemonReleaseUpgradeError) {
            throw cause;
        }
        throw new DaemonReleaseUpgradeError("release_invalid", "The installed Mobius release could not be verified", {
            cause,
        });
    }
}

export async function installDaemonReleaseVersion(version: string, signal: AbortSignal): Promise<WorkerLaunch> {
    decodeRuntimeUpgradeVersion(version);
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
        return await verifyInstalledDaemonRelease(await readInstalledRelease(prefix), prefix, version, signal);
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

async function verifyInstalledDaemonRelease(
    installed: InstalledRelease,
    prefix: string,
    version: string,
    signal: AbortSignal,
): Promise<WorkerLaunch> {
    await validateLocalPath(prefix, true, true, signal);
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
    if (!satisfies(process.versions.node, metadata.engines.node)) {
        throw new DaemonReleaseUpgradeError(
            "node_incompatible",
            `Mobius ${version} requires Node.js ${metadata.engines.node}; the running daemon uses ${process.versions.node} at ${process.execPath}. Update Node.js before retrying.`,
        );
    }
    // Run with the worker's actual executable before requesting any switch.
    // An engines declaration alone cannot detect unsupported syntax or missing dependencies.
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
    return await decodeWorkerLaunch({ executable: process.execPath, entry, version });
}

// `npm view <package> <field> --json` prints the field's value through npm 11 and
// a one-element array from npm 12. Accept exactly those shapes; anything else is
// not a version npm reported.
const npmViewVersionSchema = z
    .union([z.string(), z.tuple([z.string()])])
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
        const version = decodeRuntimeUpgradeVersion(npmViewVersionSchema.parse(JSON.parse(result.stdout)));
        return gt(version, currentVersion) ? version : null;
    } catch (cause) {
        signal.throwIfAborted();
        throw new DaemonReleaseUpgradeError("npm_check_failed", "npm could not return a valid latest Mobius version", {
            cause,
        });
    }
}
