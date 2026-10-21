import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { runtimeUpgradeVersionSchema } from "@moxt-ai/mobius-sdk/protocol";
import { gt } from "semver";
import { z } from "zod";
import { readStateDirectory } from "../../storage/state-directory.ts";
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

export async function installDaemonReleaseVersion(version: string, signal: AbortSignal): Promise<WorkerLaunch> {
    runtimeUpgradeVersionSchema.parse(version);
    const npm = await findExecutableOnPath("npm", process.env);
    if (npm === null) {
        throw new DaemonReleaseUpgradeError("npm_unavailable", "npm is required to download the new daemon");
    }
    // npm owns the package installation; never overwrite the running release.
    const prefix = join(readStateDirectory(), "npm", version);
    await mkdir(prefix, { recursive: true, mode: 0o700 });
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
        const packageRoot = await realpath(join(prefix, "node_modules", "@moxt-ai", "mobius"));
        const metadata = z
            .object({
                name: z.literal("@moxt-ai/mobius"),
                version: z.literal(version),
                bin: z.object({ mobius: z.literal("dist/cli.js") }),
            })
            .parse(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")));
        const entry = await realpath(join(packageRoot, metadata.bin.mobius));
        const resolved = relative(await realpath(prefix), entry);
        if (resolved.startsWith("..") || isAbsolute(resolved)) {
            throw new Error("Installed entry escaped npm prefix");
        }
        return await decodeWorkerLaunch({ executable: process.execPath, entry, version });
    } catch (cause) {
        signal.throwIfAborted();
        throw new DaemonReleaseUpgradeError(
            "npm_install_failed",
            "npm could not install and verify the requested Mobius version",
            { cause },
        );
    }
}

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
        const version = runtimeUpgradeVersionSchema.parse(JSON.parse(result.stdout));
        return gt(version, currentVersion) ? version : null;
    } catch (cause) {
        signal.throwIfAborted();
        throw new DaemonReleaseUpgradeError("npm_check_failed", "npm could not return a valid latest Mobius version", {
            cause,
        });
    }
}
