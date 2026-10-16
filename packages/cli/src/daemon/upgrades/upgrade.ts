import { randomUUID } from "node:crypto";
import { setInterval } from "node:timers/promises";
import { decodeIdentifier, type RuntimeUpgradeResult } from "@moxt-ai/mobius-protocol";
import packageMetadata from "../../../package.json" with { type: "json" };
import { sendLocalRequest } from "../control/local-client.ts";
import { lifecycleResponse } from "../control/protocol.ts";
import { readSwitchStatus } from "../control/switch-status.ts";
import { openMobiusControlInstallation } from "../pairing/pair-local-machine.ts";
import { DaemonUpgradeError, findNewDaemonRelease, installDaemonRelease } from "./package.ts";

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

export async function checkDaemonUpgrade(signal: AbortSignal, required = false): Promise<void> {
    const control = await openMobiusControlInstallation(signal, process.env);
    const transition = await readSwitchStatus(control.stateDirectory, signal);
    if (
        transition?.kind === "switching" ||
        (transition?.kind === "rolled-back" && transition.retryAfter > Date.now())
    ) {
        if (required) {
            throw new DaemonUpgradeError(
                "required_upgrade_blocked",
                "The required daemon upgrade is blocked by an ongoing switch or rollback cooldown",
            );
        }
        return;
    }
    const version = await findNewDaemonRelease(packageMetadata.version, signal);
    if (version === null) {
        if (required) {
            throw new DaemonUpgradeError(
                "required_upgrade_unavailable",
                "The Relay requires an upgrade but npm has no newer release",
            );
        }
        return;
    }
    const launch = await installDaemonRelease(version, signal);
    const response = lifecycleResponse.parse(
        await sendLocalRequest(
            control.stateDirectory,
            "manager",
            { kind: "switch", id: randomUUID(), context: "npm", launch },
            signal,
        ),
    );
    if (response.kind === "error") {
        throw new DaemonUpgradeError(response.code, response.message);
    }
    if (response.kind !== "switching") {
        throw new DaemonUpgradeError("manager_incompatible", "The manager does not support daemon switching");
    }
}
