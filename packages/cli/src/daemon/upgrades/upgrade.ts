import { randomUUID } from "node:crypto";
import { setInterval, setTimeout } from "node:timers/promises";
import { decodeIdentifier, type RuntimeUpgradeResult } from "@moxt-ai/mobius-protocol";
import packageMetadata from "../../../package.json" with { type: "json" };
import { isNodeError, sendLocalRequest } from "../control/local-client.ts";
import { type DaemonSwitchState, lifecycleResponse } from "../control/protocol.ts";
import { readSwitchStatus } from "../control/switch-status.ts";
import { openMobiusControlInstallation } from "../pairing/pair-local-machine.ts";
import { DaemonUpgradeError, findNewDaemonRelease, installDaemonRelease } from "./package.ts";

// A switch may consume the new worker's startup budget and the rollback restart.
const SWITCH_COMPLETION_MILLISECONDS = 300_000;
const SWITCH_POLL_MILLISECONDS = 200;

export async function reportDaemonUpgrade(
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
export async function runDaemonUpgrades(signal: AbortSignal): Promise<void> {
    try {
        for await (const _tick of setInterval(3_600_000, undefined, { signal })) {
            try {
                await checkDaemonUpgrade(signal);
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

export type DaemonUpgradeAttempt =
    | { readonly kind: "current" }
    | { readonly kind: "requested"; readonly id: string; readonly version: string };

export type DaemonSwitchOutcome =
    | Extract<DaemonSwitchState, { kind: "switched" }>
    | Extract<DaemonSwitchState, { kind: "rolled-back" }>;

// The shared one-shot upgrade: find the newest npm release beyond the running
// version, install it, and ask the manager to switch. Callers observe the
// result through awaitDaemonSwitch.
export async function requestDaemonUpgrade(
    stateDirectory: string,
    currentVersion: string,
    signal: AbortSignal,
): Promise<DaemonUpgradeAttempt> {
    const version = await findNewDaemonRelease(currentVersion, signal);
    if (version === null) {
        return { kind: "current" };
    }
    const launch = await installDaemonRelease(version, signal);
    const id = randomUUID();
    const response = lifecycleResponse.parse(
        await sendLocalRequest(stateDirectory, "manager", { kind: "switch", id, context: "npm", launch }, signal),
    );
    if (response.kind === "error") {
        throw new DaemonUpgradeError(response.code, response.message);
    }
    if (response.kind !== "switching") {
        throw new DaemonUpgradeError("manager_incompatible", "The manager does not support daemon switching");
    }
    return { kind: "requested", id, version };
}

// Wait until the manager settles the switch requested under the given id. The
// manager serializes switch work, so a bounded poll observes the terminal state
// without holding a control connection for the whole switch.
export async function awaitDaemonSwitch(
    stateDirectory: string,
    id: string,
    signal: AbortSignal,
): Promise<DaemonSwitchOutcome> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(SWITCH_COMPLETION_MILLISECONDS)]);
    let outcome: DaemonSwitchOutcome | undefined;
    while (!deadline.aborted) {
        let state: DaemonSwitchState | null;
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

async function checkDaemonUpgrade(signal: AbortSignal): Promise<void> {
    const control = await openMobiusControlInstallation(signal, process.env);
    const transition = await readSwitchStatus(control.stateDirectory, signal);
    if (
        transition?.kind === "switching" ||
        (transition?.kind === "rolled-back" && transition.retryAfter > Date.now())
    ) {
        return;
    }
    await requestDaemonUpgrade(control.stateDirectory, packageMetadata.version, signal);
}
