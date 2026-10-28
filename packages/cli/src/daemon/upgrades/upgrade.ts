import { randomUUID } from "node:crypto";
import { setInterval, setTimeout } from "node:timers/promises";
import { decodeIdentifier, type RuntimeUpgradeResult } from "@moxt-ai/mobius-sdk/protocol";
import packageMetadata from "../../../package.json" with { type: "json" };
import { RuntimeDiagnosticLog } from "../../engine/runtime/observability/diagnostic-log.ts";
import type { RuntimeTurnActivity } from "../../engine/session/turn/runtime-turn-activity.ts";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { sendLocalRequest } from "../control/local-client.ts";
import { type DaemonReleaseSwitchState, decodeKnownLifecycleResponse, type WorkerLaunch } from "../control/protocol.ts";
import { readSwitchStatus } from "../control/switch-status.ts";
import { openMobiusControlInstallation } from "../pairing/pair-local-machine.ts";
import { DaemonReleaseUpgradeError, findNewDaemonReleaseVersion, installDaemonReleaseVersion } from "./package.ts";

// A switch may consume the new worker's startup budget and the rollback restart.
const SWITCH_COMPLETION_MILLISECONDS = 300_000;
const SWITCH_POLL_MILLISECONDS = 200;
// An automatic switch disconnects every client for tens of seconds. Wait until the
// Runtime has been idle long enough that the user has likely stepped away.
const UPGRADE_QUIET_MILLISECONDS = 30 * 60_000;
const UPGRADE_QUIET_CHECK_MILLISECONDS = 60_000;

export async function reportDaemonUpgradeAvailability(
    send: (result: RuntimeUpgradeResult) => void,
    signal: AbortSignal,
): Promise<void> {
    if (!process.connected) {
        return;
    }
    const control = await openMobiusControlInstallation(signal, process.env);
    const transition = await readSwitchStatus(control.stateDirectory, signal, true);
    if (transition === null) {
        return;
    }
    const base = {
        kind: "runtime.upgrade.result",
        requestId: decodeIdentifier(transition.id),
        version: packageMetadata.version,
        targetVersion: transition.next.version,
    };
    if (transition.kind === "rolled-back" && transition.previous.version === packageMetadata.version) {
        send({
            ...base,
            kind: "runtime.upgrade.result",
            outcome: {
                status: "failed",
                code: transition.code,
                message: transition.message,
                retryAfter: transition.retryAfter,
                stdout: transition.stdout,
                stderr: transition.stderr,
            },
        });
    } else if (transition.next.version === packageMetadata.version) {
        send({ ...base, kind: "runtime.upgrade.result", outcome: { status: "succeeded" } });
    }
}

// One loop belongs to the worker, regardless of how many Relay connections it owns.
// Await each attempt so checks and installations never overlap.
export async function runDaemonReleaseUpgrades(signal: AbortSignal, activity: RuntimeTurnActivity): Promise<void> {
    try {
        for await (const _tick of setInterval(3_600_000, undefined, { signal })) {
            try {
                await checkDaemonReleaseUpgrade(signal, activity);
            } catch (cause) {
                signal.throwIfAborted();
                console.error("Daemon npm upgrade check failed", cause);
            }
        }
    } catch (cause) {
        if (!signal.aborted) {
            throw cause;
        }
    }
}

export type DaemonReleaseUpgradeAttempt =
    | { readonly kind: "current" }
    | { readonly kind: "requested"; readonly id: string; readonly version: string };

export type DaemonReleaseSwitchOutcome =
    | Extract<DaemonReleaseSwitchState, { kind: "switched" }>
    | Extract<DaemonReleaseSwitchState, { kind: "rolled-back" }>;

// The shared one-shot upgrade: find the newest npm release beyond the running
// version, install it, and ask the manager to switch. Callers observe the
// result through awaitDaemonReleaseSwitch.
export async function requestDaemonReleaseUpgrade(
    stateDirectory: InstallationDirectory,
    currentVersion: string,
    signal: AbortSignal,
): Promise<DaemonReleaseUpgradeAttempt> {
    const version = await findNewDaemonReleaseVersion(currentVersion, signal);
    if (version === null) {
        return { kind: "current" };
    }
    const launch = await installDaemonReleaseVersion(version, signal);
    return await requestInstalledDaemonReleaseSwitch(stateDirectory, launch, signal);
}

async function requestInstalledDaemonReleaseSwitch(
    stateDirectory: InstallationDirectory,
    launch: WorkerLaunch,
    signal: AbortSignal,
): Promise<Extract<DaemonReleaseUpgradeAttempt, { kind: "requested" }>> {
    const id = randomUUID();
    const response = decodeKnownLifecycleResponse(
        await sendLocalRequest(stateDirectory, "manager", { kind: "switch", id, context: "npm", launch }, signal),
    );
    if (response?.kind === "error") {
        throw new DaemonReleaseUpgradeError(response.code, response.message);
    }
    if (response?.kind !== "switching") {
        throw new DaemonReleaseUpgradeError("manager_incompatible", "The manager does not support daemon switching");
    }
    return { kind: "requested", id, version: launch.version };
}

// Wait until the manager settles the switch requested under the given id. The
// manager serializes switch work, so a bounded poll observes the terminal state
// without holding a control connection for the whole switch.
export async function awaitDaemonReleaseSwitch(
    stateDirectory: InstallationDirectory,
    id: string,
    signal: AbortSignal,
): Promise<DaemonReleaseSwitchOutcome> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(SWITCH_COMPLETION_MILLISECONDS)]);
    let outcome: DaemonReleaseSwitchOutcome | undefined;
    while (!deadline.aborted) {
        let state: DaemonReleaseSwitchState | null;
        try {
            state = await readSwitchStatus(stateDirectory, deadline);
        } catch (cause) {
            // The manager is the only writer of switch state; without it the switch is over.
            if (isNodeError(cause, "ENOENT") || isNodeError(cause, "ECONNREFUSED")) {
                throw cause;
            }
            deadline.throwIfAborted();
            state = null;
        }
        if (state !== null && state.id === id && state.kind !== "switching") {
            outcome = state;
            break;
        }
        await setTimeout(SWITCH_POLL_MILLISECONDS, undefined, { signal: deadline });
    }
    if (outcome === undefined) {
        throw deadline.reason;
    }
    // The manager records a rollback before restoring the previous worker; a
    // queued status read returns only once that restoration finished.
    if (outcome.kind === "rolled-back") {
        deadline.throwIfAborted();
        await readSwitchStatus(stateDirectory, deadline, true).catch(() => undefined);
    }
    return outcome;
}

async function reserveWhenQuiet(activity: RuntimeTurnActivity, signal: AbortSignal): Promise<Disposable> {
    for (;;) {
        await activity.whenIdle(signal);
        // Idle has begun; check until it has lasted the quiet period or work resumes.
        for await (const _tick of setInterval(UPGRADE_QUIET_CHECK_MILLISECONDS, undefined, { signal })) {
            const reservation = activity.reserveIfQuiet(UPGRADE_QUIET_MILLISECONDS);
            if (reservation !== null) {
                return reservation;
            }
            if (activity.count() > 0) {
                break;
            }
        }
        signal.throwIfAborted();
    }
}

async function checkDaemonReleaseUpgrade(signal: AbortSignal, activity: RuntimeTurnActivity): Promise<void> {
    const control = await openMobiusControlInstallation(signal, process.env);
    const transition = await readSwitchStatus(control.stateDirectory, signal);
    if (
        transition?.kind === "switching" ||
        (transition?.kind === "rolled-back" && transition.retryAfter > Date.now())
    ) {
        return;
    }
    const version = await findNewDaemonReleaseVersion(packageMetadata.version, signal);
    if (version === null) {
        return;
    }
    const launch = await installDaemonReleaseVersion(version, signal);
    let reservation = activity.reserveIfQuiet(UPGRADE_QUIET_MILLISECONDS);
    if (reservation === null) {
        new RuntimeDiagnosticLog(control.stateDirectory).record(
            `Mobius daemon diagnostic ${JSON.stringify({
                timestamp: new Date().toISOString(),
                event: "daemon_upgrade_deferred",
                version,
                activeWork: activity.count(),
                ...activity.describe(),
            })}`,
        );
        reservation = await reserveWhenQuiet(activity, signal);
    }
    using _reservation = reservation;
    signal.throwIfAborted();
    await requestInstalledDaemonReleaseSwitch(control.stateDirectory, launch, signal);
    // The manager now owns the switch. Hold admission until it stops this worker;
    // releasing it after the RPC would let a new prompt race the shutdown.
    await new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
        } else {
            signal.addEventListener("abort", () => resolve(), { once: true });
        }
    });
}
