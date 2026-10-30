import { logger } from "@moxt-ai/mobius-relay-core/logging";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import type { ProjectDO } from "../durable-objects/project-do.ts";
import { decodePlatformProjectPlacement, projectIdFromPrefixedValue } from "../entity/platform-project-id.ts";
import { encodeProjectDurableObjectPath } from "../entity/project-durable-object-path.ts";
import type { PlatformProjectStore } from "../infra/platform-project-store.ts";

export interface ProjectWorkerRoutingBindings {
    readonly PROJECT_RELAY: DurableObjectNamespace<ProjectDO>;
}

/** A request executing inside the Project Durable Object, beside the Project's own store. */
export interface ProjectDurableObjectExecutionBindings extends ProjectWorkerRoutingBindings {
    readonly MOBIUS_PROJECT_STORE: PlatformProjectStore;
    readonly MOBIUS_PROJECT_ID: string;
}

export type ProjectDurableObjectRoutingBindings = ProjectWorkerRoutingBindings | ProjectDurableObjectExecutionBindings;

function failure(code: string, status: number): Response {
    return Response.json({ error: { code, message: "Project routing is unavailable" } }, { status });
}

function projectIdFromPath(pathname: string): string | null {
    const prefix = `${MOBIUS_API_PREFIX}/v1/projects/`;
    if (!pathname.startsWith(prefix)) {
        return null;
    }
    try {
        return decodeURIComponent(pathname.slice(prefix.length).split("/")[0] ?? "");
    } catch {
        return "";
    }
}

async function projectIdFromUnscopedRequest(request: Request): Promise<string | null> {
    const pathname = new URL(request.url).pathname;
    for (const segment of pathname.split("/")) {
        let value: string;
        try {
            value = decodeURIComponent(segment);
        } catch {
            return "";
        }
        const projectId = projectIdFromPrefixedValue(value);
        if (projectId !== null) {
            return projectId;
        }
    }
    const pairingPrefix = `${MOBIUS_API_PREFIX}/v1/runtime-pairings/`;
    if (pathname.startsWith(pairingPrefix) && pathname.endsWith("/redeem")) {
        try {
            const pairingId = decodeURIComponent(pathname.slice(pairingPrefix.length, -"/redeem".length));
            return projectIdFromPrefixedValue(pairingId) ?? "";
        } catch {
            return "";
        }
    }
    if (pathname === `${MOBIUS_API_PREFIX}/v1/runtimes/connect`) {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
        return projectIdFromPrefixedValue(token) ?? "";
    }
    const authorization = request.headers.get("authorization") ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const credentialProject = projectIdFromPrefixedValue(bearer);
    if (credentialProject !== null) {
        return credentialProject;
    }
    return null;
}

export async function routeProjectDurableObject(
    request: Request,
    bindings: ProjectDurableObjectRoutingBindings,
    allowedOrigins: ReadonlySet<string>,
): Promise<Response | null> {
    if ("MOBIUS_PROJECT_STORE" in bindings) {
        return null;
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === `${MOBIUS_API_PREFIX}/dashboard` || pathname.startsWith(`${MOBIUS_API_PREFIX}/dashboard/`)) {
        return null;
    }
    if (pathname.includes("/recording/sessions")) {
        return null;
    }
    const projectId = projectIdFromPath(pathname) ?? (await projectIdFromUnscopedRequest(request));
    if (projectId === null) {
        return null;
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.has("*") && !allowedOrigins.has(origin)) {
        return Response.json(
            { error: { code: "browser_origin_denied", message: "The browser origin is not allowed" } },
            { status: 403 },
        );
    }
    const placement = decodePlatformProjectPlacement(projectId);
    if (placement === null) {
        return failure("project_id_invalid", 400);
    }
    request.signal.throwIfAborted();
    const durableObjectUrl = new URL(request.url);
    durableObjectUrl.pathname = encodeProjectDurableObjectPath(projectId, durableObjectUrl.pathname);
    const body = request.body === null ? undefined : await request.arrayBuffer();
    request.signal.throwIfAborted();
    try {
        return await bindings.PROJECT_RELAY.getByName(projectId, { locationHint: placement.locationHint }).fetch(
            durableObjectUrl,
            {
                method: request.method,
                headers: request.headers,
                ...(body === undefined ? {} : { body }),
                signal: request.signal,
                redirect: request.redirect,
            },
        );
    } catch (error) {
        logger.error(
            {
                event: "project_relay_request_failed",
                durableObjectClass: "ProjectDO",
                durableObjectId: bindings.PROJECT_RELAY.idFromName(projectId).toString(),
                projectId,
                cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                method: request.method,
                path: durableObjectUrl.pathname,
                err: error,
            },
            "Project Relay request failed",
        );
        throw error;
    }
}
