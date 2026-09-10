import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
import {
    decodeProjectCredential,
    decodeProjectPermissions,
    type ExternalIdentityAuthenticator,
    ExternalIdentityCredential,
    ProjectPermission,
} from "../../entity/authentication/project-authentication.ts";
import type { ProjectAuthenticationService } from "../../service/authentication/project-authentication-service.ts";
import { botErrorResponse } from "../bot/bot-error-response.ts";
import {
    actorReference,
    bearer,
    boolean,
    externalCredential,
    identifier,
    integer,
    pageLimit,
    pathIdentifier,
    positiveInteger,
    requestBody,
    string,
} from "../bot/bot-input.ts";

interface LegacyAuthenticationHttpEnvironment {
    readonly Bindings: {
        readonly services: {
            readonly externalIdentityAuthenticator: ExternalIdentityAuthenticator;
            readonly projectAuthentication: ProjectAuthenticationService;
        };
    };
    readonly Variables: { readonly signal: AbortSignal };
}

export function createLegacyAuthenticationApplication() {
    return new Hono<LegacyAuthenticationHttpEnvironment>({ strict: false })
        .basePath(`${MOBIUS_API_PREFIX}/v1`)
        .use("*", async (c, next) => {
            c.set("signal", AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]));
            await next();
        })
        .onError((error, c) => {
            c.req.raw.signal.throwIfAborted();
            return botErrorResponse(error);
        })
        .post("/auth/exchanges/:providerId", async (c) => {
            const value = await requestBody(c.req.raw, ["expiresInSeconds", "projectId"]);
            const issued = await c.env.services.projectAuthentication.exchangeExternalIdentity(
                pathIdentifier(c.req.param("providerId")),
                externalCredential(c.req.raw),
                identifier(value, "projectId"),
                positiveInteger(value, "expiresInSeconds") * 1_000,
                c.env.services.externalIdentityAuthenticator,
                c.var.signal,
            );
            return c.json(
                {
                    credential: issued.credential,
                    credentialId: issued.credentialId,
                    expiresAt: new Date(issued.expiresAtEpochMilliseconds).toISOString(),
                    permissions: [...issued.permissions].map((permission) => permission.value),
                    projectId: issued.scope.projectId,
                    tenantId: issued.scope.storageLocator.resolveHostingPlacement(),
                },
                201,
            );
        })
        .get("/projects/:projectId/applications", async (c) => {
            const access = await c.env.services.projectAuthentication.authorizeProject(
                pathIdentifier(c.req.param("projectId")),
                bearer(c.req.raw),
                ProjectPermission.ApplicationsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            return c.json(await c.env.services.projectAuthentication.listApplications(access, c.var.signal));
        })
        .post("/projects/:projectId/applications", async (c) => {
            const access = await c.env.services.projectAuthentication.authorizeProject(
                pathIdentifier(c.req.param("projectId")),
                bearer(c.req.raw),
                ProjectPermission.ApplicationsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            const value = await requestBody(c.req.raw, ["name", "permissions"]);
            return c.json(
                await c.env.services.projectAuthentication.createApplication(
                    access,
                    string(value, "name", 120),
                    decodeProjectPermissions(value["permissions"]),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/project-applications/:applicationId/credentials", async (c) => {
            const access = await c.env.services.projectAuthentication.authorize(
                decodeProjectCredential(bearer(c.req.raw)),
                ProjectPermission.ApplicationsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            const value = await requestBody(c.req.raw, ["expiresInSeconds"]);
            return c.json(
                await c.env.services.projectAuthentication.issueApplicationCredential(
                    access,
                    pathIdentifier(c.req.param("applicationId")),
                    positiveInteger(value, "expiresInSeconds") * 1_000,
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/project-applications/:applicationId/revoke", async (c) => {
            const access = await c.env.services.projectAuthentication.authorize(
                decodeProjectCredential(bearer(c.req.raw)),
                ProjectPermission.ApplicationsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            await requestBody(c.req.raw, []);
            return c.json(
                await c.env.services.projectAuthentication.revokeApplication(
                    access,
                    pathIdentifier(c.req.param("applicationId")),
                    c.var.signal,
                ),
            );
        })
        .post("/project-application-credentials/:credentialId/rotate", async (c) => {
            const access = await c.env.services.projectAuthentication.authorize(
                decodeProjectCredential(bearer(c.req.raw)),
                ProjectPermission.ApplicationsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            const value = await requestBody(c.req.raw, ["expiresInSeconds", "overlapSeconds"]);
            return c.json(
                await c.env.services.projectAuthentication.rotateApplicationCredential(
                    access,
                    pathIdentifier(c.req.param("credentialId")),
                    positiveInteger(value, "expiresInSeconds") * 1_000,
                    integer(value, "overlapSeconds") * 1_000,
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/project-application-credentials/:credentialId/revoke", async (c) => {
            const access = await c.env.services.projectAuthentication.authorize(
                decodeProjectCredential(bearer(c.req.raw)),
                ProjectPermission.ApplicationsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            await requestBody(c.req.raw, []);
            return c.json(
                await c.env.services.projectAuthentication.revokeApplicationCredential(
                    access,
                    pathIdentifier(c.req.param("credentialId")),
                    c.var.signal,
                ),
            );
        })
        .get("/projects/:projectId/external-identity-bindings", async (c) => {
            const access = await c.env.services.projectAuthentication.authorizeProject(
                pathIdentifier(c.req.param("projectId")),
                bearer(c.req.raw),
                ProjectPermission.IdentityBindingsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            return c.json(
                await c.env.services.projectAuthentication.listExternalIdentityBindings(access, c.var.signal),
            );
        })
        .post("/projects/:projectId/external-identity-bindings", async (c) => {
            const access = await c.env.services.projectAuthentication.authorizeProject(
                pathIdentifier(c.req.param("projectId")),
                bearer(c.req.raw),
                ProjectPermission.IdentityBindingsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            const value = await requestBody(c.req.raw, [
                "externalCredential",
                "permissions",
                "providerId",
                "revokeOwnerCredential",
            ]);
            const revokeOwnerCredential = boolean(value, "revokeOwnerCredential");
            const identity = await c.env.services.externalIdentityAuthenticator.authenticate(
                new ExternalIdentityCredential(
                    identifier(value, "providerId"),
                    string(value, "externalCredential", 16 * 1_024),
                ),
                c.var.signal,
            );
            return c.json(
                await c.env.services.projectAuthentication.attachExternalIdentity(
                    access,
                    identity,
                    decodeProjectPermissions(value["permissions"]),
                    revokeOwnerCredential,
                    c.var.signal,
                ),
                201,
            );
        })
        .delete("/projects/:projectId/external-identity-bindings/:bindingId", async (c) => {
            const access = await c.env.services.projectAuthentication.authorizeProject(
                pathIdentifier(c.req.param("projectId")),
                bearer(c.req.raw),
                ProjectPermission.IdentityBindingsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            return c.json(
                await c.env.services.projectAuthentication.revokeExternalIdentityBinding(
                    access,
                    pathIdentifier(c.req.param("bindingId")),
                    c.var.signal,
                ),
            );
        })
        .get("/projects/:projectId/owner-credentials", async (c) => {
            const access = await c.env.services.projectAuthentication.authorizeProject(
                pathIdentifier(c.req.param("projectId")),
                bearer(c.req.raw),
                ProjectPermission.OwnerCredentialsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            return c.json(await c.env.services.projectAuthentication.listOwnerCredentials(access, c.var.signal));
        })
        .post("/project-owner-credentials/:credentialId/rotate", async (c) => {
            const access = await c.env.services.projectAuthentication.authorize(
                decodeProjectCredential(bearer(c.req.raw)),
                ProjectPermission.OwnerCredentialsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            const value = await requestBody(c.req.raw, ["overlapSeconds"]);
            return c.json(
                await c.env.services.projectAuthentication.rotateOwnerCredential(
                    access,
                    pathIdentifier(c.req.param("credentialId")),
                    integer(value, "overlapSeconds") * 1_000,
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/project-owner-credentials/:credentialId/revoke", async (c) => {
            const access = await c.env.services.projectAuthentication.authorize(
                decodeProjectCredential(bearer(c.req.raw)),
                ProjectPermission.OwnerCredentialsManage,
                actorReference(c.req.raw),
                c.var.signal,
            );
            await requestBody(c.req.raw, []);
            return c.json(
                await c.env.services.projectAuthentication.revokeOwnerCredential(
                    access,
                    pathIdentifier(c.req.param("credentialId")),
                    c.var.signal,
                ),
            );
        })
        .get("/projects/:projectId/authentication-audit-events", async (c) => {
            const access = await c.env.services.projectAuthentication.authorizeProject(
                pathIdentifier(c.req.param("projectId")),
                bearer(c.req.raw),
                ProjectPermission.ProjectRead,
                actorReference(c.req.raw),
                c.var.signal,
            );
            return c.json(
                await c.env.services.projectAuthentication.listAuditEvents(
                    access,
                    pageLimit(new URL(c.req.raw.url)),
                    c.var.signal,
                ),
            );
        });
}
