import { Hono } from "hono";
import {
    validateAgentCatalog,
    validateAgents,
    validateDisplayName,
    validateIdentifier,
    validateInstallableAgents,
    validatePairingCode,
} from "../../entity/pairing/pairing.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import { pairingTimeoutMiddleware } from "../middleware/pairing-timeout-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createPairingRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .use("/", pairingTimeoutMiddleware("Pairing creation timed out"))
        .post("/", async (context) => {
            const clientFingerprint = context.req.header("cf-connecting-ip") ?? "unavailable";
            return context.json(await context.env.services.createPairing(clientFingerprint, context.var.signal), 201);
        })
        .route("/", createPairingClaimRoutes())
        .get("/:pairingId", async (context) => {
            const pairings = context.env.services.pairings;
            return context.json(
                await pairings.readPairingStatus(
                    validateIdentifier(context.req.param("pairingId"), "pairing_id"),
                    context.req.query("token") ?? "",
                    context.req.raw.signal,
                ),
            );
        });
}

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
            },
        );
}
