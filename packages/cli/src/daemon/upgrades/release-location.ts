import { isInstalledReleaseEntry } from "../../storage/daemon/release-files.ts";
import { canonicalPath } from "../../storage/files/local-files.ts";
import type { WorkerLaunch } from "../control/protocol.ts";
import { ensureWorkingProcess, readWorkingProcessVersion } from "../lifecycle/manager-client.ts";
import { currentWorkerLaunch } from "../lifecycle/worker-process.ts";
import { DaemonReleaseUpgradeError, installDaemonReleaseVersion, readInstalledDaemonRelease } from "./package.ts";

/**
 * Where the daemon of this CLI's release runs. An installed CLI runs it from the release npm keeps in the
 * state directory, where `mobius upgrade` puts every release, so replacing or removing the CLI never changes
 * what the daemon runs. A source checkout has no release to install and runs in place.
 */
export async function resolveDaemonLaunch(version: string, signal: AbortSignal): Promise<WorkerLaunch> {
    const own = currentWorkerLaunch(version);
    if (!isInstalledReleaseEntry(await canonicalPath(own.entry))) {
        return own;
    }
    const installed = await readInstalledDaemonRelease(version, signal);
    if (installed !== null) {
        return installed;
    }
    process.stdout.write(`Installing Mobius ${version}...\n`);
    try {
        return await installDaemonReleaseVersion(version, signal);
    } catch (cause) {
        signal.throwIfAborted();
        if (!(cause instanceof DaemonReleaseUpgradeError)) {
            throw cause;
        }
        // Another CLI may have finished the same installation while this one failed.
        const concurrent = await readInstalledDaemonRelease(version, signal);
        if (concurrent !== null) {
            return concurrent;
        }
        // A daemon from this CLI beats no daemon: `mobius start` is how a stopped daemon comes back.
        process.stderr.write(
            `Mobius ${version} could not be installed (${cause.code}); running the daemon from this CLI instead.\n`,
        );
        return own;
    }
}

/** Ensures the daemon of this CLI's release is running, started from the location `resolveDaemonLaunch` names. */
export async function ensureWorkingDaemon(stateDirectory: string, version: string, signal: AbortSignal): Promise<void> {
    if ((await readWorkingProcessVersion(stateDirectory, signal)) === version) {
        return;
    }
    await ensureWorkingProcess(stateDirectory, await resolveDaemonLaunch(version, signal), signal);
}
