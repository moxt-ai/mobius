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
import type { BotService } from "../../service/bot/bot-service.ts";
import { botErrorResponse } from "./bot-error-response.ts";
import {
    actorReference,
    bearer,
    boolean,
    completionPolicy,
    connectorScopes,
    conversationRequest,
    cursor,
    executionCapability,
    externalCredential,
    identifier,
    identifiers,
    integer,
    messageRequest,
    object,
    pageLimit,
    pathIdentifier,
    positiveInteger,
    requestBody,
    string,
} from "./bot-input.ts";

interface BotHttpEnvironment {
    readonly Bindings: {
        readonly services: {
            readonly bots: BotService;
            readonly externalIdentityAuthenticator: ExternalIdentityAuthenticator;
            readonly projectAuthentication: ProjectAuthenticationService;
        };
    };
    readonly Variables: { readonly signal: AbortSignal };
}

export function createBotApplication() {
    return new Hono<BotHttpEnvironment>({ strict: false })
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
                    tenantId: issued.scope.tenantId,
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
        })
        .get("/projects", async (c) => {
            const tenant = await c.env.services.bots.resolveTenant(c.req.raw, c.var.signal);
            return c.json({ projects: await c.env.services.bots.listProjects(tenant, c.var.signal) });
        })
        .get("/projects/:projectId/bots", async (c) => {
            if (c.req.raw.headers.has("authorization")) {
                return c.json(
                    await c.env.services.bots.listOwnedBots(
                        pathIdentifier(c.req.param("projectId")),
                        bearer(c.req.raw),
                        actorReference(c.req.raw),
                        c.var.signal,
                    ),
                );
            }
            const tenant = await c.env.services.bots.resolveTenant(c.req.raw, c.var.signal);
            return c.json({
                bots: await c.env.services.bots.listProjectBots(
                    tenant,
                    pathIdentifier(c.req.param("projectId")),
                    c.var.signal,
                ),
            });
        })
        .get("/projects/:projectId/status", async (c) => {
            const tenant = await c.env.services.bots.resolveTenant(c.req.raw, c.var.signal);
            return c.json(
                await c.env.services.bots.readProjectStatus(
                    tenant,
                    pathIdentifier(c.req.param("projectId")),
                    c.var.signal,
                ),
            );
        })
        .post("/projects/:projectId/bots", async (c) => {
            const value = await requestBody(c.req.raw, ["avatarRef", "description", "displayName"]);
            return c.json(
                await c.env.services.bots.createBot(
                    pathIdentifier(c.req.param("projectId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    string(value, "displayName", 80),
                    string(value, "avatarRef", 4096, true),
                    string(value, "description", 2000, true),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .get("/bots/:botId", async (c) =>
            c.json(
                await c.env.services.bots.readBot(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .get("/bots/:botId/behavior-revisions", async (c) =>
            c.json(
                await c.env.services.bots.listBehaviorRevisions(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .get("/bots/:botId/execution-bindings", async (c) =>
            c.json(
                await c.env.services.bots.listExecutionBindings(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .get("/bots/:botId/connections", async (c) =>
            c.json(
                await c.env.services.bots.listConnections(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .get("/bots/:botId/conversations", async (c) =>
            c.json(
                await c.env.services.bots.listConversations(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .get("/bots/:botId/setup", async (c) =>
            c.json(
                await c.env.services.bots.readSetup(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .post("/bots/:botId/profile-revisions", async (c) => {
            const value = await requestBody(c.req.raw, ["avatarRef", "description", "displayName", "expectedRevision"]);
            return c.json(
                await c.env.services.bots.createProfileRevision(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    string(value, "displayName", 80),
                    string(value, "avatarRef", 4096, true),
                    string(value, "description", 2000, true),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bots/:botId/behavior-revisions", async (c) => {
            const value = await requestBody(c.req.raw, [
                "agentConfiguration",
                "expectedRevision",
                "instructions",
                "requiredCapabilities",
            ]);
            return c.json(
                await c.env.services.bots.createBehaviorRevision(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    string(value, "instructions", 100_000, true),
                    identifiers(value, "requiredCapabilities", 32),
                    object(value, "agentConfiguration"),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bots/:botId/execution-bindings", async (c) => {
            const value = await requestBody(c.req.raw, [
                "agentConfigRevision",
                "agentRef",
                "allowedDeliveryTargetIds",
                "behaviorRevisionId",
                "completionPolicy",
                "expectedRevision",
                "runtimeId",
                "workspaceRef",
            ]);
            return c.json(
                await c.env.services.bots.createExecutionBinding(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    identifier(value, "behaviorRevisionId"),
                    identifier(value, "runtimeId"),
                    identifier(value, "agentRef"),
                    string(value, "workspaceRef", 2048),
                    positiveInteger(value, "agentConfigRevision"),
                    identifiers(value, "allowedDeliveryTargetIds", 64),
                    completionPolicy(value),
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        })
        .post("/bots/:botId/connection-grants", async (c) => {
            const value = await requestBody(c.req.raw, ["audience", "expiresInSeconds", "label", "scopes"]);
            return c.json(
                await c.env.services.bots.createGrant(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    identifier(value, "audience"),
                    string(value, "label", 200),
                    connectorScopes(value),
                    integer(value, "expiresInSeconds"),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bots/:botId/delivery-targets/:targetId/approve", async (c) => {
            const value = await requestBody(c.req.raw, ["expectedPolicyRevision"]);
            return c.json(
                await c.env.services.bots.approveTarget(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("targetId")),
                    integer(value, "expectedPolicyRevision"),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/suspend", async (c) => {
            const value = await requestBody(c.req.raw, ["expectedRevision"]);
            return c.json(
                await c.env.services.bots.transitionBot(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    "suspend",
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/connections/:connectionId/revoke", async (c) => {
            const value = await requestBody(c.req.raw, ["expectedRevision"]);
            return c.json(
                await c.env.services.bots.revokeConnectionForOwner(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("connectionId")),
                    integer(value, "expectedRevision"),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/archive", async (c) => {
            const value = await requestBody(c.req.raw, ["expectedRevision"]);
            return c.json(
                await c.env.services.bots.transitionBot(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    "archive",
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/resume", async (c) => {
            const value = await requestBody(c.req.raw, ["expectedRevision"]);
            return c.json(
                await c.env.services.bots.transitionBot(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    "resume",
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/conversations", async (c) =>
            c.json(
                await c.env.services.bots.createConversation(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    conversationRequest(await requestBody(c.req.raw)),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            ),
        )
        .post("/bots/:botId/conversations/:conversationId/messages", async (c) => {
            const submission = messageRequest(await requestBody(c.req.raw));
            return c.json(
                await c.env.services.bots.submitMessage(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("conversationId")),
                    submission,
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        })
        .get("/bots/:botId/conversations/:conversationId/events", async (c) =>
            c.json(
                await c.env.services.bots.readConversationEvents(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("conversationId")),
                    c.req.query("after") ?? "",
                    c.var.signal,
                ),
            ),
        )
        .post("/bots/:botId/turns/:turnId/cancel", async (c) => {
            const value = await requestBody(c.req.raw, ["idempotencyKey"]);
            return c.json(
                await c.env.services.bots.cancelTurn(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("turnId")),
                    identifier(value, "idempotencyKey"),
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        })
        .post("/bot-connection-grants/redeem", async (c) => {
            const value = await requestBody(c.req.raw, ["audience", "connectorPrincipalId", "grantId", "grantSecret"]);
            return c.json(
                await c.env.services.bots.redeemGrant(
                    identifier(value, "grantId"),
                    string(value, "grantSecret", 256),
                    identifier(value, "audience"),
                    string(value, "connectorPrincipalId", 500),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bot-connections/:connectionId/credentials/rotate", async (c) => {
            await requestBody(c.req.raw, []);
            return c.json(
                await c.env.services.bots.rotateCredential(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bot-connections/:connectionId/revoke", async (c) => {
            await requestBody(c.req.raw, []);
            return c.json(
                await c.env.services.bots.revokeConnection(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bot-connections/:connectionId/delivery-targets", async (c) => {
            const value = await requestBody(c.req.raw, ["alias"]);
            return c.json(
                await c.env.services.bots.createTarget(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    identifier(value, "alias"),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bot-connections/:connectionId/delivery-targets/:targetId/disable", async (c) => {
            await requestBody(c.req.raw, []);
            return c.json(
                await c.env.services.bots.disableTarget(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    pathIdentifier(c.req.param("targetId")),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .get("/bot-connections/:connectionId/outbound-events", async (c) =>
            c.json(
                await c.env.services.bots.readOutbound(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    cursor(new URL(c.req.url)),
                    pageLimit(new URL(c.req.url)),
                    Date.now(),
                    c.var.signal,
                ),
            ),
        )
        .post("/bot-connections/:connectionId/outbound-messages/:messageId/delivered", async (c) => {
            const value = await requestBody(c.req.raw, ["claimId"]);
            return c.json(
                await c.env.services.bots.delivered(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    pathIdentifier(c.req.param("messageId")),
                    identifier(value, "claimId"),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bot-connections/:connectionId/outbound-messages/:messageId/retryable-failure", async (c) => {
            const value = await requestBody(c.req.raw, ["claimId", "code", "retryAfterSeconds"]);
            return c.json(
                await c.env.services.bots.retryableFailure(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    pathIdentifier(c.req.param("messageId")),
                    identifier(value, "claimId"),
                    identifier(value, "code"),
                    integer(value, "retryAfterSeconds"),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bot-connections/:connectionId/outbound-messages/:messageId/terminal-failure", async (c) => {
            const value = await requestBody(c.req.raw, ["claimId", "code"]);
            return c.json(
                await c.env.services.bots.terminalFailure(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    pathIdentifier(c.req.param("messageId")),
                    identifier(value, "claimId"),
                    identifier(value, "code"),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bot-executions/:executionId/reply-messages", async (c) => {
            const value = await requestBody(c.req.raw, ["idempotencyKey", "text"]);
            return c.json(
                await c.env.services.bots.acceptOutbound(
                    pathIdentifier(c.req.param("executionId")),
                    bearer(c.req.raw),
                    executionCapability(c.req.raw),
                    { kind: "reply" },
                    { idempotencyKey: identifier(value, "idempotencyKey"), text: string(value, "text", 10_000) },
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        })
        .post("/bot-executions/:executionId/delivery-targets/:targetId/messages", async (c) => {
            const value = await requestBody(c.req.raw, ["idempotencyKey", "text"]);
            return c.json(
                await c.env.services.bots.acceptOutbound(
                    pathIdentifier(c.req.param("executionId")),
                    bearer(c.req.raw),
                    executionCapability(c.req.raw),
                    { kind: "target", id: pathIdentifier(c.req.param("targetId")) },
                    { idempotencyKey: identifier(value, "idempotencyKey"), text: string(value, "text", 10_000) },
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        });
}
