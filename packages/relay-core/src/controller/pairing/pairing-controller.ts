import { Hono } from "hono";
import { assertExactKeys, directoryError, parseJsonBody, preserveCancellation } from "../../infra/relay-http.ts";
import {
    validateAgentCatalog,
    validateAgents,
    validateDisplayName,
    validateIdentifier,
    validateInstallableAgents,
    validatePairingCode,
} from "../../service/pairing/pairing.ts";
import type { PairingService } from "../../service/pairing/pairing-service.ts";

export class PairingController {
    static readonly inject = ["pairings"] satisfies readonly ["pairings"];
    readonly routes: Hono;

    constructor(pairings: PairingService) {
        const controller = new Hono();

        controller.post("/", async (context) => {
            try {
                return context.json(await pairings.createPairing(context.req.raw.signal), 201);
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        });

        controller.post("/claim", async (context) => {
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

        controller.get("/:pairingId", async (context) => {
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

        this.routes = controller;
    }
}
