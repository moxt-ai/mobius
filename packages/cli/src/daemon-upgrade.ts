import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    type RuntimeUpgradeRequest,
    type RuntimeUpgradeResult,
    runtimeUpgradeRequestSchema,
} from "@moxt-ai/mobius-protocol";
import { z } from "zod";
import packageMetadata from "../package.json" with { type: "json" };
import type { AuditStore } from "./audit/audit-store.ts";
import { lifecycleResponse } from "./daemon-lifecycle-protocol.ts";
import { isNodeError, sendLocalRequest } from "./daemon-local-control.ts";
import { readSwitchState, waitForSwitchResult, writePrivateJson } from "./daemon-switch-state.ts";
import { DaemonUpgradeError, installDaemonRelease } from "./daemon-upgrade-package.ts";
import { openMobiusControlInstallation } from "./pairing/pair-local-machine.ts";

// Shared by every Relay connection in this working process.
let upgradeInProgress = false;

const pendingUpgrade = z.object({ request: runtimeUpgradeRequestSchema, relayKey: z.string() }).readonly();
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
    const transition = await waitForSwitchResult(control.stateDirectory, signal);
    if (transition === null) {
        return;
    }
    let pending: z.infer<typeof pendingUpgrade>;
    try {
        pending = pendingUpgrade.parse(
            JSON.parse(await readFile(join(control.stateDirectory, "upgrade-request.json"), "utf8")),
        );
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            return;
        }
        throw cause;
    }
    if (pending.request.requestId !== transition.id || pending.relayKey !== relayKey(relayUrl)) {
        return;
    }
    const base = {
        kind: "runtime.upgrade.result",
        requestId: pending.request.requestId,
        version: packageMetadata.version,
        targetVersion: pending.request.version,
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
            },
        });
    } else if (transition.next.version === packageMetadata.version) {
        send({ ...base, kind: "runtime.upgrade.result", outcome: { status: "succeeded" } });
    }
}

export async function requestDaemonUpgrade(
    request: RuntimeUpgradeRequest,
    relayUrl: URL,
    audit: AuditStore,
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
        const transition = await readSwitchState(control.stateDirectory);
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
        audit.record({
            event: "runtime_upgrade_requested",
            commandId: request.requestId,
            sessionId: "runtime",
            details: { version: request.version },
        });
        reply({ status: "accepted" });
        const launch = await installDaemonRelease(request.version, signal);
        await writePrivateJson(control.stateDirectory, "upgrade-request.json", {
            request,
            relayKey: relayKey(relayUrl),
        });
        const response = lifecycleResponse.parse(
            await sendLocalRequest(
                control.stateDirectory,
                "manager",
                { kind: "switch", id: request.requestId, launch },
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
        audit.record({
            event: "runtime_upgrade_failed",
            commandId: request.requestId,
            sessionId: "runtime",
            details: { code },
        });
        reply({ status: "failed", code, message, retryAfter: 0 });
    } finally {
        upgradeInProgress = false;
    }
}
