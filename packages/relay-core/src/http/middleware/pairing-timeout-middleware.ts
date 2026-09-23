import type { MiddlewareHandler } from "hono";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";
import { requestTimeoutMiddleware } from "./request-timeout-middleware.ts";

export function pairingTimeoutMiddleware(message: string): MiddlewareHandler<RelayHttpEnvironment> {
    return requestTimeoutMiddleware<RelayHttpEnvironment>(
        15_000,
        (cause) => new PairingDirectoryError("pairing_timeout", message, { cause }),
    );
}
