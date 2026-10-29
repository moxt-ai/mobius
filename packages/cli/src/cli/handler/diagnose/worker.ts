import { join } from "node:path";
import { z } from "zod";
import { MobiusRuntimeEngine } from "../../../engine/runtime/engine.ts";
import { describeRelayFailure } from "../../../engine/runtime/relay/diagnostics.ts";
import { ensureProbeDirectory } from "../../../storage/diagnostics/relay-probe-files.ts";
import { configuredProbeProxy, failureCode, type RelayProbeRole, readProbeConfiguration } from "./config.ts";
import { collectRouteEvidence, type RouteEvidence } from "./routes.ts";

export async function runRelayProbeWorker(
    configPath: string,
    role: RelayProbeRole,
    directory: string,
    signal: AbortSignal,
): Promise<void> {
    if (!process.send) {
        throw new Error("The relay probe worker requires its coordinator");
    }
    const notify = (message: object): void => {
        if (process.connected) {
            process.send?.({ ...message, role }, (error) => {
                if (error !== null) {
                    controller.abort();
                }
            });
        }
    };
    const controller = new AbortController();
    const stopped = AbortSignal.any([signal, controller.signal]);
    const start = Promise.withResolvers<void>();
    const onMessage = (value: unknown): void => {
        const message = z.object({ action: z.enum(["start", "stop"]) }).safeParse(value);
        if (!message.success) {
            return;
        }
        if (message.data.action === "start") {
            start.resolve();
        } else {
            controller.abort();
        }
    };
    const abort = (): void => {
        controller.abort();
        start.resolve();
    };
    process.on("message", onMessage);
    process.once("disconnect", abort);
    stopped.addEventListener("abort", abort, { once: true });
    let routesBefore: readonly RouteEvidence[] = [];
    try {
        const config = await readProbeConfiguration(configPath, stopped);
        const origin = new URL(config.relayOrigin);
        const proxy = role === "proxy" ? configuredProbeProxy() : null;
        routesBefore = await Promise.all([
            collectRouteEvidence(origin.hostname, stopped),
            ...(proxy === null ? [] : [collectRouteEvidence(proxy.hostname, stopped)]),
        ]);
        const workspace = join(directory, "workspace");
        await ensureProbeDirectory(workspace);
        const engine = new MobiusRuntimeEngine({
            engineDataDir: join(directory, "state"),
            agentLaunchEnvironment: { HOME: join(directory, "home"), PATH: "" },
        });
        const pairing = config[role];
        const connection = await engine.pair(
            {
                relayOrigin: origin.href,
                pairingId: pairing.pairingId,
                pairingCode: pairing.pairingCode,
                defaultWorkspace: workspace,
            },
            stopped,
        );
        notify({ kind: "prepared", channelId: connection.channelId, runtimeId: connection.runtimeId, routesBefore });
        await start.promise;
        if (!stopped.aborted) {
            await engine.runLoop({
                connection: { kind: "saved", connectionId: connection.connectionId },
                signal: stopped,
                onConnectionStatus: (status) => notify({ kind: "status", status, timestamp: new Date().toISOString() }),
            });
        }
        const routesAfter = await Promise.all([
            collectRouteEvidence(origin.hostname, AbortSignal.timeout(6_000)),
            ...(proxy === null ? [] : [collectRouteEvidence(proxy.hostname, AbortSignal.timeout(6_000))]),
        ]);
        notify({ kind: "finished", routesAfter });
    } catch (error) {
        if (!stopped.aborted) {
            notify({ kind: "failed", code: failureCode(error), details: describeRelayFailure(error), routesBefore });
            process.exitCode = 1;
        }
    } finally {
        stopped.removeEventListener("abort", abort);
        process.off("message", onMessage);
        process.off("disconnect", abort);
        if (process.connected) {
            process.disconnect();
        }
    }
}
