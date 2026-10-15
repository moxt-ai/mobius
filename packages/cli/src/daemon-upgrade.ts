import { createHash } from "node:crypto";
import {
    type RuntimeUpgradeRequest,
    type RuntimeUpgradeResult,
    runtimeUpgradeRequestSchema,
} from "@moxt-ai/mobius-protocol";
import packageMetadata from "../package.json" with { type: "json" };
import { lifecycleResponse } from "./daemon-lifecycle-protocol.ts";
import { sendLocalRequest } from "./daemon-local-control.ts";
import { readSwitchStatus } from "./daemon-switch-status.ts";
import { DaemonUpgradeError, installDaemonRelease } from "./daemon-upgrade-package.ts";
import { openMobiusControlInstallation } from "./pairing/pair-local-machine.ts";

// Shared by every Relay connection in this working process.
let upgradeInProgress = false;

const relayKey = (url: URL): string => createHash("sha256").update(url.href).digest("hex");

export async function reportDaemonUpgrade(
    relayUrl: URL,
    send: (result: RuntimeUpgradeResult) => void,
    signal: AbortSignal,
): Promise<void> {
    if (!process.connected) {
        return;
    }
    const control = await openMobiusControlInstallation(signal, process.env);
    const transition = await readSwitchStatus(control.stateDirectory, signal, true);
    if (transition === null || transition.context !== relayKey(relayUrl)) {
        return;
    }
    const request = runtimeUpgradeRequestSchema.parse({
        kind: "runtime.upgrade.request",
        requestId: transition.id,
        version: transition.next.version,
    });
    const base = {
        kind: "runtime.upgrade.result",
        requestId: request.requestId,
        version: packageMetadata.version,
        targetVersion: request.version,
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

export async function requestDaemonUpgrade(
    request: RuntimeUpgradeRequest,
    relayUrl: URL,
    send: (result: RuntimeUpgradeResult) => void,
    signal: AbortSignal,
): Promise<void> {
    const reply = (outcome: RuntimeUpgradeResult["outcome"]): void =>
        send({
            kind: "runtime.upgrade.result",
            requestId: request.requestId,
            version: packageMetadata.version,
            targetVersion: request.version,
            outcome,
        });
    const reject = (code: string, message: string, retryAfter = 0): void =>
        reply({ status: "rejected", code, message, retryAfter });
    // The trusted local capability is restricted to this package and exact releases;
    // remote callers cannot choose commands, registries, install paths or npm flags.
    runtimeUpgradeRequestSchema.parse(request);
    if (!process.connected) {
        reject("manager_required", "This daemon must be started by its manager to upgrade");
        return;
    }
    if (upgradeInProgress) {
        reject("upgrade_busy", "Another upgrade is already in progress");
        return;
    }
    upgradeInProgress = true;
    try {
        const control = await openMobiusControlInstallation(signal, process.env);
        const transition = await readSwitchStatus(control.stateDirectory, signal);
        if (transition?.kind === "rolled-back" && transition.retryAfter > Date.now()) {
            reject("upgrade_cooldown", "Upgrades are blocked for one hour after a failed start", transition.retryAfter);
            return;
        }
        if (transition?.kind === "switching") {
            reject("upgrade_busy", "Another upgrade is already in progress");
            return;
        }
        if (request.version === packageMetadata.version) {
            reply({ status: "succeeded" });
            return;
        }
        reply({ status: "accepted" });
        const launch = await installDaemonRelease(request.version, signal);
        const response = lifecycleResponse.parse(
            await sendLocalRequest(
                control.stateDirectory,
                "manager",
                { kind: "switch", id: request.requestId, context: relayKey(relayUrl), launch },
                signal,
            ),
        );
        if (response.kind === "error") {
            throw new DaemonUpgradeError(response.code, response.message);
        }
        if (response.kind !== "switching") {
            throw new DaemonUpgradeError("manager_incompatible", "The manager does not support daemon switching");
        }
    } catch (cause) {
        signal.throwIfAborted();
        const code = cause instanceof DaemonUpgradeError ? cause.code : "upgrade_failed";
        const message =
            cause instanceof DaemonUpgradeError ? cause.message : "The daemon upgrade could not be prepared";
        reply({ status: "failed", code, message, retryAfter: 0 });
    } finally {
        upgradeInProgress = false;
    }
}
