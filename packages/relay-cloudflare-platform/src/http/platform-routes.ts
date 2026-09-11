import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { PairingDirectoryError, ProjectAuthenticationError } from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import * as v from "valibot";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import type { PlatformControlPlaneService } from "../service/platform-control-plane-service.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;

const requiredString = v.pipe(v.string(), v.minLength(1));
const safeInteger = v.pipe(v.number(), v.safeInteger());
const createTenantBody = v.strictObject({
    displayName: requiredString,
    quotas: v.optional(
        v.strictObject({
            activeApps: v.number(),
            activeProjects: v.number(),
            activeSessions: v.number(),
        }),
    ),
});
const createAppBody = v.strictObject({ displayName: requiredString, tenantId: requiredString });
const createProjectBody = v.strictObject({
    displayName: requiredString,
    idempotencyKey: requiredString,
    clientReference: v.optional(v.string(), ""),
    placement: v.strictObject({
        d1ShardId: requiredString,
        r2BucketId: requiredString,
    }),
});
const issueCredentialBody = v.strictObject({
    expiresInSeconds: safeInteger,
    permissions: v.array(v.string()),
    projectIds: v.array(v.string()),
});
const rotateCredentialBody = v.strictObject({ expiresInSeconds: safeInteger, overlapSeconds: safeInteger });
const emptyBody = v.strictObject({});

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
        .post("/v1/platform/tenants", bodyParser(createTenantBody), async (context) => {
            const value = context.req.valid("json");
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.control.createTenant(identity, value.displayName, value.quotas, context.var.signal),
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
        .post("/v1/apps", bodyParser(createAppBody), async (context) => {
            const value = context.req.valid("json");
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const access = await context.env.control.requireTenantDeveloper(
                identity,
                path(value.tenantId),
                context.var.signal,
            );
            return context.json(
                await context.env.control.createApp(access, value.displayName, context.var.signal),
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
        .post("/v1/apps/:appId/projects", bodyParser(createProjectBody), async (context) => {
            const value = context.req.valid("json");
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
                    value.displayName,
                    value.idempotencyKey,
                    value.clientReference,
                    value.placement,
                    context.var.signal,
                ),
                201,
            );
        })
        .post("/v1/apps/:appId/credentials", bodyParser(issueCredentialBody), async (context) => {
            const value = context.req.valid("json");
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
                    value.permissions,
                    value.projectIds,
                    value.expiresInSeconds,
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
        .post(
            "/v1/platform/app-credentials/:credentialId/rotate",
            bodyParser(rotateCredentialBody),
            async (context) => {
                const value = context.req.valid("json");
                const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
                return context.json(
                    await context.env.control.rotateAppCredential(
                        identity,
                        path(context.req.param("credentialId")),
                        value.expiresInSeconds,
                        value.overlapSeconds,
                        context.var.signal,
                    ),
                    201,
                );
            },
        )
        .post("/v1/platform/app-credentials/:credentialId/revoke", bodyParser(emptyBody), async (context) => {
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
