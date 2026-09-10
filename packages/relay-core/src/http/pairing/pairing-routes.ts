import { Hono } from "hono";
import {
    PairingDirectoryError,
    validateAgentCatalog,
    validateAgents,
    validateDisplayName,
    validateIdentifier,
    validateInstallableAgents,
    validatePairingCode,
} from "../../entity/pairing/pairing.ts";
import { assertExactKeys, directoryError, parseJsonBody, preserveCancellation } from "../../infra/relay-http.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createPairingRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .post("/", async (context) => {
            const request = context.req.raw;
            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
            try {
                return context.json(await context.env.services.createPairing(request, signal), 201);
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
        .route("/", createPairingClaimRoutes())
        .get("/:pairingId", async (context) => {
            const pairings = context.env.services.pairings;
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

export function createPairingClaimRoutes() {
    return new Hono<RelayHttpEnvironment>().post("/claim", async (context) => {
        const pairings = context.env.services.pairings;
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
    });
}
