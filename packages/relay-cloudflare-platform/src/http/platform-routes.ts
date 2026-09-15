import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { errorMiddleware, requestTimeoutMiddleware, rethrowHonoError } from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import * as v from "valibot";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import {
    appCredentialAuthentication,
    authenticateWith,
    developerOidcAuthentication,
    type PlatformAuthenticationEnvironment,
} from "../middleware/authentication.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { createBrowserCors } from "../middleware/browser-cors.ts";
import type { OrganizationInviteService } from "../service/organization-invite-service.ts";
import { requestedProjectId } from "./conversation-request.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;

const requiredString = v.pipe(v.string(), v.minLength(1));
const safeInteger = v.pipe(v.number(), v.safeInteger());
const createAppBody = v.strictObject({ displayName: requiredString, tenantId: requiredString });
const updateDisplayNameBody = v.strictObject({ displayName: requiredString });
const createProjectBody = v.strictObject({
    displayName: requiredString,
    idempotencyKey: requiredString,
    clientReference: v.optional(v.string(), ""),
    locationHint: requiredString,
});
const issueCredentialBody = v.strictObject({
    permissions: v.array(v.string()),
    projectIds: v.array(v.string()),
});
const rotateCredentialBody = v.strictObject({ overlapSeconds: safeInteger });
const emptyBody = v.strictObject({});
const inviteBody = v.strictObject({ token: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)) });

type PlatformHttpEnvironment = PlatformAuthenticationEnvironment & {
    readonly Bindings: { readonly allowedOrigins: ReadonlySet<string>; readonly invites: OrganizationInviteService };
};

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
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .use(
            "*",
            requestTimeoutMiddleware<PlatformHttpEnvironment>(
                OPERATION_TIMEOUT_MILLISECONDS,
                (cause) =>
                    new PlatformControlPlaneError(
                        "platform_timeout",
                        "The Platform request timed out. Please retry",
                        504,
                        { cause },
                    ),
            ),
        )
        .use(
            "*",
            createBrowserCors(
                ["GET", "POST", "PUT", "DELETE"],
                ["authorization", "content-type", "x-mobius-oidc-provider"],
            ),
        )
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
        .get("/v1/projects/:projectId/storage-placement", (context) =>
            context.json(
                context.env.control.resolveProjectPlacement(path(context.req.param("projectId")), context.var.signal),
            ),
        )
        .get("/v1/platform/configuration", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(await context.env.control.readPlatformConfiguration(identity, context.var.signal));
        })
        .post("/v1/platform/tenants/:tenantId/invite-links", bodyParser(emptyBody), async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.invites.create(identity, path(context.req.param("tenantId")), context.var.signal),
                201,
            );
        })
        .get("/v1/platform/tenants/:tenantId/invite-links", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.invites.list(identity, path(context.req.param("tenantId")), context.var.signal),
            );
        })
        .delete("/v1/platform/tenants/:tenantId/invite-links/:inviteId", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.invites.revoke(
                    identity,
                    path(context.req.param("tenantId")),
                    path(context.req.param("inviteId")),
                    context.var.signal,
                ),
            );
        })
        .post("/v1/platform/invite-links/preview", bodyParser(inviteBody), async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.invites.preview(identity, context.req.valid("json").token, context.var.signal),
            );
        })
        .post("/v1/platform/invite-links/accept", bodyParser(inviteBody), async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.invites.accept(identity, context.req.valid("json").token, context.var.signal),
            );
        })
        .get("/v1/platform/tenants", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(await context.env.control.listTenants(identity, context.var.signal));
        })
        .get("/v1/platform/tenants/:tenantId", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.control.readTenantResource(
                    identity,
                    path(context.req.param("tenantId")),
                    context.var.signal,
                ),
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
            if (context.req.query("project_id") !== undefined) {
                throw new PlatformControlPlaneError("invalid_request", "Use the Project audit-events endpoint", 400);
            }
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const access = await context.env.control.requireTenantDeveloper(
                identity,
                path(context.req.param("tenantId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.listTenantAuditEvents(
                    access,
                    null,
                    queryLimit(context.req.query("limit")),
                    context.var.signal,
                ),
            );
        })
        .get("/v1/projects/:projectId/audit-events", async (context) => {
            const projectId = requestedProjectId(context.req.raw);
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            return context.json(
                await context.env.control.listProjectAuditEvents(
                    identity,
                    projectId,
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
        .put("/v1/apps/:appId", bodyParser(updateDisplayNameBody), async (context) => {
            const value = context.req.valid("json");
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const result = await context.env.control.requireAppDeveloper(
                identity,
                path(context.req.param("appId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.updateApp(result.access, result.app, value.displayName, context.var.signal),
            );
        })
        .delete("/v1/apps/:appId", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const result = await context.env.control.requireAppDeveloper(
                identity,
                path(context.req.param("appId")),
                context.var.signal,
            );
            return context.json(await context.env.control.deleteApp(result.access, result.app, context.var.signal));
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
        .post(
            "/v1/apps/:appId/projects",
            bodyParser(createProjectBody),
            authenticateWith(appCredentialAuthentication, developerOidcAuthentication),
            async (context) => {
                const value = context.req.valid("json");
                return context.json(
                    await context.env.control.provisionAppProject(
                        context.var.principal,
                        path(context.req.param("appId")),
                        value.displayName,
                        value.idempotencyKey,
                        value.clientReference,
                        value.locationHint,
                        context.var.signal,
                    ),
                    201,
                );
            },
        )
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
                    context.var.signal,
                ),
                201,
            );
        })
        .get("/v1/apps/:appId/credentials", async (context) => {
            const identity = await context.env.control.authenticateDeveloper(context.req.raw, context.var.signal);
            const result = await context.env.control.requireAppDeveloper(
                identity,
                path(context.req.param("appId")),
                context.var.signal,
            );
            return context.json(
                await context.env.control.listAppCredentials(result.access, result.app, context.var.signal),
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
