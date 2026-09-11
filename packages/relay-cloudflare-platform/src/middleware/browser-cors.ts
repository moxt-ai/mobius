import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { createMiddleware } from "hono/factory";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";

const BROWSER_CORS_HEADERS = new Set(["authorization", "content-type", "x-mobius-upload-token"]);
const BROWSER_CORS_METHODS = new Set(["GET", "POST", "PUT"]);

interface BrowserCorsEnvironment {
    readonly Bindings: { readonly allowedOrigins: ReadonlySet<string> };
}

function browserCorsHeaders(origin: string): Headers {
    return new Headers({
        "access-control-allow-headers": "authorization, content-type, x-mobius-upload-token",
        "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
        "access-control-allow-origin": origin,
        "access-control-expose-headers":
            "content-length, content-type, x-mobius-artifact-id, x-mobius-sha256, x-mobius-event-format",
        "access-control-max-age": "600",
        vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    });
}

export const browserCors = createMiddleware<BrowserCorsEnvironment>(async (context, next) => {
    if (!context.req.path.startsWith(`${MOBIUS_API_PREFIX}/v1/client/session`)) {
        await next();
        return context.res;
    }
    const origin = context.req.header("origin") ?? "";
    if (origin.length > 0 && !context.env.allowedOrigins.has("*") && !context.env.allowedOrigins.has(origin)) {
        throw new PlatformControlPlaneError("browser_origin_denied", "The browser origin is not allowed", 403);
    }
    if (context.req.method === "OPTIONS") {
        if (origin.length === 0) {
            throw new PlatformControlPlaneError("browser_origin_denied", "The browser origin is not allowed", 403);
        }
        const requestedMethod = context.req.header("access-control-request-method") ?? "";
        const requestedHeaders = (context.req.header("access-control-request-headers") ?? "")
            .split(",")
            .map((header) => header.trim().toLowerCase())
            .filter((header) => header.length > 0);
        if (
            !BROWSER_CORS_METHODS.has(requestedMethod) ||
            requestedHeaders.some((header) => !BROWSER_CORS_HEADERS.has(header))
        ) {
            throw new PlatformControlPlaneError(
                "browser_preflight_denied",
                "The browser preflight request is not allowed",
                403,
            );
        }
        return new Response(null, { headers: browserCorsHeaders(origin), status: 204 });
    }
    await next();
    if (origin.length > 0) {
        for (const [name, value] of browserCorsHeaders(origin)) {
            context.res.headers.set(name, value);
        }
    }
    return context.res;
});
