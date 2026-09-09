import { Hono } from "hono";
import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
import {
    assertExactKeys,
    bearerToken,
    directoryError,
    parseJsonBody,
    preserveCancellation,
    readString,
} from "../../infra/relay-http.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

const PROJECT_RUNTIME_OPERATION_TIMEOUT_MILLISECONDS = 15_000;

export function createProjectRuntimePairingRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .post("/projects/:projectId/runtime-pairings", async (context) => {
            const request = context.req.raw;
            const signal = AbortSignal.any([
                request.signal,
                AbortSignal.timeout(PROJECT_RUNTIME_OPERATION_TIMEOUT_MILLISECONDS),
            ]);
            try {
                const body = await parseJsonBody(request);
                assertExactKeys(body, ["idempotencyKey"]);
                return context.json(
                    await context.env.services.runtimePairings.createProjectRuntimePairing(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(request),
                        validateIdentifier(readString(body, "idempotencyKey"), "idempotency_key"),
                        signal,
                    ),
                    201,
                );
            } catch (error) {
                preserveCancellation(request.signal, error);
                if (signal.aborted) {
                    return directoryError(
                        new PairingDirectoryError("pairing_timeout", "Runtime pairing creation timed out", {
                            cause: error,
                        }),
                    );
                }
                return directoryError(error);
            }
        })
        .get("/projects/:projectId/runtime-pairings/:pairingId", async (context) => {
            const request = context.req.raw;
            const signal = AbortSignal.any([
                request.signal,
                AbortSignal.timeout(PROJECT_RUNTIME_OPERATION_TIMEOUT_MILLISECONDS),
            ]);
            try {
                return context.json(
                    await context.env.services.runtimePairings.readProjectRuntimePairing(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        validateIdentifier(context.req.param("pairingId"), "pairing_id"),
                        bearerToken(request),
                        signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(request.signal, error);
                if (signal.aborted) {
                    return directoryError(
                        new PairingDirectoryError("pairing_timeout", "Runtime pairing lookup timed out", {
                            cause: error,
                        }),
                    );
                }
                return directoryError(error);
            }
        })
        .delete("/projects/:projectId/runtimes/:runtimeId", async (context) => {
            const request = context.req.raw;
            const signal = AbortSignal.any([
                request.signal,
                AbortSignal.timeout(PROJECT_RUNTIME_OPERATION_TIMEOUT_MILLISECONDS),
            ]);
            try {
                await context.env.services.runtimePairings.revokeProjectRuntime(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                    bearerToken(request),
                    signal,
                );
                return new Response(null, { status: 204 });
            } catch (error) {
                preserveCancellation(request.signal, error);
                if (signal.aborted) {
                    return directoryError(
                        new PairingDirectoryError("pairing_timeout", "Runtime revocation timed out", {
                            cause: error,
                        }),
                    );
                }
                return directoryError(error);
            }
        });
}
