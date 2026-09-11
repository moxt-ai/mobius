import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { PairingDirectoryError, ProjectAuthenticationError } from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { PlatformControlPlaneService } from "../service/platform-control-plane-service.ts";

const MAXIMUM_BODY_BYTES = 128 * 1_024;
const OPERATION_TIMEOUT_MILLISECONDS = 15_000;

interface PlatformHttpEnvironment {
    readonly Bindings: { readonly control: PlatformControlPlaneService };
    readonly Variables: { readonly signal: AbortSignal };
}

function errorResponse(error: unknown): Response {
    if (error instanceof PlatformControlPlaneError) {
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    if (error instanceof ProjectAuthenticationError || error instanceof PairingDirectoryError) {
        return Response.json({ error: { code: error.code, message: error.message } }, { status: 400 });
    }
    return Response.json(
        { error: { code: "platform_internal_error", message: "The Platform request could not be completed" } },
        { status: 500 },
    );
}

async function body(request: Request, allowedKeys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "application/json") {
        throw new PlatformControlPlaneError("invalid_request", "A JSON request body is required", 400);
    }
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAXIMUM_BODY_BYTES) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is too large", 413);
    }
    const encoded = await request.text();
    if (new TextEncoder().encode(encoded).byteLength > MAXIMUM_BODY_BYTES) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is too large", 413);
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is invalid", 400, { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is invalid", 400);
    }
    const result = Object.freeze(Object.fromEntries(Object.entries(value)));
    if (Object.keys(result).some((key) => !allowedKeys.includes(key))) {
        throw new PlatformControlPlaneError("invalid_request", "The request body contains an unsupported field", 400);
    }
    return result;
}

function string(value: Readonly<Record<string, unknown>>, key: string, allowEmpty = false): string {
    const field = value[key];
    if (typeof field !== "string" || (!allowEmpty && field.length === 0)) {
        throw new PlatformControlPlaneError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function optionalString(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = value[key];
    if (field === undefined) {
        return "";
    }
    if (typeof field !== "string") {
        throw new PlatformControlPlaneError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function integer(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field)) {
        throw new PlatformControlPlaneError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function stringArray(value: Readonly<Record<string, unknown>>, key: string): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.some((entry) => typeof entry !== "string")) {
        throw new PlatformControlPlaneError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return Object.freeze(field.filter((entry) => typeof entry === "string"));
}

function path(value: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
        throw new PlatformControlPlaneError("invalid_request", "A Platform resource identifier is invalid", 400);
    }
    return value;
}

function queryLimit(value: unknown): number {
    if (value === undefined) {
        return 100;
    }
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new PlatformControlPlaneError("invalid_request", "The page size is invalid", 400);
    }
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > 500) {
        throw new PlatformControlPlaneError("invalid_request", "The page size is invalid", 400);
    }
    return result;
}

export function createPlatformControlApplication() {
    return new Hono<PlatformHttpEnvironment>({ strict: false })
        .basePath(MOBIUS_API_PREFIX)
        .use("*", async (context, next) => {
            context.set(
                "signal",
                AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MILLISECONDS)]),
            );
            await next();
        })
        .onError((error, context) => {
            context.req.raw.signal.throwIfAborted();
            return errorResponse(error);
        })
        .get("/health", (context) => context.json({ service: "mobius-relay-platform", status: "ok" }))
        .get("/capabilities", (context) =>
            context.json({
                apiVersion: 1,
                hosting: { anonymousPublicBootstrap: false, profile: "platform" },
                resources: {
                    apps: true,
                    appCredentials: true,
                    conversationAccessCredentials: true,
                    projects: true,
                    tenants: true,
                },
            }),
        )
        .get("/v1/platform/configuration", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(await context.env.control.readPlatformConfiguration(identity, context.var.signal));
        })
        .post("/v1/platform/tenants", async (context) => {
            const value = await body(context.req.raw, ["displayName", "quotas"]);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.control.createTenant(
                    identity,
                    string(value, "displayName"),
                    value["quotas"],
                    context.var.signal,
                ),
                201,
            );
        })
        .get("/v1/platform/tenants/:tenantId/usage", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const access = await context.env.control.requireTenantDeveloper(
                identity,
                path(context.req.param("tenantId")),
                context.var.signal,
            );
            return context.json(await context.env.control.readTenantUsage(access, context.var.signal));
        })
        .get("/v1/platform/tenants/:tenantId/audit-events", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const access = await context.env.control.requireTenantDeveloper(
                identity,
                path(context.req.param("tenantId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.listTenantAuditEvents(
                    access,
                    queryLimit(context.req.query("limit")),
                    context.var.signal,
                ),
            );
        })
        .post("/v1/apps", async (context) => {
            const value = await body(context.req.raw, ["displayName", "tenantId"]);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const access = await context.env.control.requireTenantDeveloper(
                identity,
                path(string(value, "tenantId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.createApp(access, string(value, "displayName"), context.var.signal),
                201,
            );
        })
        .get("/v1/apps/:appId", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.control.readAppResource(
                    identity,
                    path(context.req.param("appId")),
                    context.var.signal,
                ),
            );
        })
        .get("/v1/apps/:appId/projects", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const result = await context.env.control.requireAppDeveloper(
                identity,
                path(context.req.param("appId")),
                context.var.signal,
            );
            return context.json(await context.env.control.listProjects(result.access, result.app, context.var.signal));
        })
        .post("/v1/apps/:appId/projects", async (context) => {
            const value = await body(context.req.raw, ["clientReference", "displayName", "idempotencyKey"]);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const result = await context.env.control.requireAppDeveloper(
                identity,
                path(context.req.param("appId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.createProject(
                    result.access,
                    result.app,
                    string(value, "displayName"),
                    string(value, "idempotencyKey"),
                    optionalString(value, "clientReference"),
                    context.var.signal,
                ),
                201,
            );
        })
        .post("/v1/apps/:appId/credentials", async (context) => {
            const value = await body(context.req.raw, ["expiresInSeconds", "permissions", "projectIds"]);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const result = await context.env.control.requireAppDeveloper(
                identity,
                path(context.req.param("appId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.issueAppCredential(
                    result.access,
                    result.app,
                    value["permissions"],
                    stringArray(value, "projectIds"),
                    integer(value, "expiresInSeconds"),
                    context.var.signal,
                ),
                201,
            );
        })
        .get("/v1/platform/tenants/:tenantId/apps", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const access = await context.env.control.requireTenantDeveloper(
                identity,
                path(context.req.param("tenantId")),
                context.var.signal,
            );
            return context.json(await context.env.control.listApps(access, context.var.signal));
        })
        .post("/v1/platform/tenants/:tenantId/apps", async (context) => {
            const value = await body(context.req.raw, ["displayName"]);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const access = await context.env.control.requireTenantDeveloper(
                identity,
                path(context.req.param("tenantId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.createApp(access, string(value, "displayName"), context.var.signal),
                201,
            );
        })
        .get("/v1/platform/apps/:appId/projects", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const result = await context.env.control.requireAppDeveloper(
                identity,
                path(context.req.param("appId")),
                context.var.signal,
            );
            return context.json(await context.env.control.listProjects(result.access, result.app, context.var.signal));
        })
        .post("/v1/platform/apps/:appId/projects", async (context) => {
            const value = await body(context.req.raw, ["clientReference", "displayName", "idempotencyKey"]);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const result = await context.env.control.requireAppDeveloper(
                identity,
                path(context.req.param("appId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.createProject(
                    result.access,
                    result.app,
                    string(value, "displayName"),
                    string(value, "idempotencyKey"),
                    optionalString(value, "clientReference"),
                    context.var.signal,
                ),
                201,
            );
        })
        .post("/v1/platform/apps/:appId/credentials", async (context) => {
            const value = await body(context.req.raw, ["expiresInSeconds", "permissions", "projectIds"]);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const result = await context.env.control.requireAppDeveloper(
                identity,
                path(context.req.param("appId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.issueAppCredential(
                    result.access,
                    result.app,
                    value["permissions"],
                    stringArray(value, "projectIds"),
                    integer(value, "expiresInSeconds"),
                    context.var.signal,
                ),
                201,
            );
        })
        .post("/v1/platform/app-credentials/:credentialId/rotate", async (context) => {
            const value = await body(context.req.raw, ["expiresInSeconds", "overlapSeconds"]);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.control.rotateAppCredential(
                    identity,
                    path(context.req.param("credentialId")),
                    integer(value, "expiresInSeconds"),
                    integer(value, "overlapSeconds"),
                    context.var.signal,
                ),
                201,
            );
        })
        .post("/v1/platform/app-credentials/:credentialId/revoke", async (context) => {
            await body(context.req.raw, []);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.control.revokeAppCredential(
                    identity,
                    path(context.req.param("credentialId")),
                    context.var.signal,
                ),
            );
        });
}
