import { Hono } from "hono";
import { assertExactKeys, directoryError, parseJsonBody, preserveCancellation } from "../../infra/relay-http.ts";
import {
    PairingDirectoryError,
    validateAgentCatalog,
    validateAgents,
    validateDisplayName,
    validateIdentifier,
    validateInstallableAgents,
    validatePairingCode,
} from "../../service/pairing/pairing.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createPairingRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .post("/", async (context) => {
            const pairings = context.env.gateways.pairingGateway;
            const request = context.req.raw;
            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
            try {
                const tenantId = await context.env.gateways.pairingTenantResolver.resolve(request, signal);
                signal.throwIfAborted();
                return context.json(await pairings.createPairing(tenantId, signal), 201);
            } catch (error) {
                preserveCancellation(request.signal, error);
                if (signal.aborted) {
                    return directoryError(
                        new PairingDirectoryError("pairing_timeout", "Pairing creation timed out", { cause: error }),
                    );
                }
                return directoryError(error);
            }
        })
        .post("/claim", async (context) => {
            const pairings = context.env.gateways.pairingGateway;
            try {
                const body = await parseJsonBody(context.req.raw);
                assertExactKeys(body, ["agents", "installableAgents", "machineName", "pairingCode", "workspaceName"]);
                const {
                    agents: agentsValue,
                    installableAgents: installableAgentsValue,
                    machineName,
                    pairingCode,
                    workspaceName,
                } = body;
                const agents = validateAgents(agentsValue);
                const installableAgents = validateInstallableAgents(installableAgentsValue);
                validateAgentCatalog(agents, installableAgents);
                return context.json(
                    await pairings.claimPairing(
                        validatePairingCode(pairingCode),
                        validateDisplayName(machineName, "machine_name"),
                        validateDisplayName(workspaceName, "workspace_name"),
                        agents,
                        installableAgents,
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        })
        .get("/:pairingId", async (context) => {
            const pairings = context.env.gateways.pairingGateway;
            try {
                return context.json(
                    await pairings.readPairingStatus(
                        validateIdentifier(context.req.param("pairingId"), "pairing_id"),
                        context.req.query("token") ?? "",
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        });
}
