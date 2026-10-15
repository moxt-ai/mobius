import { Hono } from "hono";
import {
    validateAgentCatalog,
    validateAgents,
    validateDisplayName,
    validateLegacyInstallableAgents,
    validatePairingCode,
} from "../../entity/pairing/pairing.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createPairingClaimRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .post(
            "/claim",
            bodyParser<RelayHttpEnvironment>([
                "agents",
                "installableAgents",
                "machineName",
                "pairingCode",
                "workspaceName",
            ]),
            async (context) => {
                const pairings = context.env.services.pairings;
                const body = context.req.valid("json");
                const { agents: agentsValue, machineName, pairingCode, workspaceName } = body;
                const agents = validateAgents(agentsValue);
                validateLegacyInstallableAgents(body["installableAgents"]);
                validateAgentCatalog(agents);
                return context.json(
                    await pairings.claimPairing(
                        validatePairingCode(pairingCode),
                        validateDisplayName(machineName, "machine_name"),
                        validateDisplayName(workspaceName, "workspace_name"),
                        agents,
                        context.req.raw.signal,
                    ),
                );
            },
        );
}
