import { Hono } from "hono";

import {
  validateAgentCatalog,
  validateAgents,
  validateDisplayName,
  validateIdentifier,
  validateInstallableAgents,
  validatePairingCode,
} from "../pairing-directory.ts";
import type { PairingUseCases } from "../relay-use-cases.ts";
import {
  assertExactKeys,
  directoryError,
  parseJsonBody,
  preserveCancellation,
} from "./relay-http.ts";

export function createPairingRoutes(useCases: PairingUseCases): Hono {
  const app = new Hono();

  app.post("/", async (context) => {
    try {
      return context.json(
        await useCases.createPairing(context.req.raw.signal),
        201,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return directoryError(error);
    }
  });

  app.post("/claim", async (context) => {
    try {
      const body = await parseJsonBody(context.req.raw);
      assertExactKeys(body, [
        "agents",
        "installableAgents",
        "machineName",
        "pairingCode",
        "workspaceName",
      ]);
      const agents = validateAgents(body["agents"]);
      const installableAgents = validateInstallableAgents(
        body["installableAgents"],
      );
      validateAgentCatalog(agents, installableAgents);
      return context.json(
        await useCases.claimPairing(
          validatePairingCode(body["pairingCode"]),
          validateDisplayName(body["machineName"], "machine_name"),
          validateDisplayName(body["workspaceName"], "workspace_name"),
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

  app.get("/:pairingId", async (context) => {
    try {
      return context.json(
        await useCases.readPairingStatus(
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

  return app;
}
