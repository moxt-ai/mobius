import type { SqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import { decodePlatformProjectPlacement, projectIdFromPrefixedValue } from "../entity/platform-project-id.ts";
import { encodeProjectDurableObjectPath } from "../entity/project-durable-object-path.ts";

export interface ProjectWorkerRoutingBindings {
    readonly PROJECT_RELAY: DurableObjectNamespace;
}

export interface ProjectDurableObjectExecutionBindings extends ProjectWorkerRoutingBindings {
    readonly MOBIUS_PROJECT_DATABASE: SqlDatabase;
    readonly MOBIUS_PROJECT_ID: string;
}

export type ProjectDurableObjectRoutingBindings = ProjectWorkerRoutingBindings | ProjectDurableObjectExecutionBindings;

function failure(code: string, status: number): Response {
    return Response.json({ error: { code, message: "Project routing is unavailable" } }, { status });
}

function projectIdFromPath(pathname: string): string | null {
    for (const prefix of [`${MOBIUS_API_PREFIX}/v1/projects/`, `${MOBIUS_API_PREFIX}/projects/`]) {
        if (!pathname.startsWith(prefix)) {
            continue;
        }
        try {
            return decodeURIComponent(pathname.slice(prefix.length).split("/")[0] ?? "");
        } catch {
            return "";
        }
    }
    return null;
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

function isRecordingSessionStatusRead(request: Request): boolean {
    if (request.method !== "GET") {
        return false;
    }
    const url = new URL(request.url);
    const prefix = `${MOBIUS_API_PREFIX}/v1/projects/`;
    if (!url.pathname.startsWith(prefix)) {
        return false;
    }
    const parts = url.pathname.slice(prefix.length).split("/");
    const isSessionPath =
        (parts.length === 4 || parts.length === 5) && parts[1] === "runtimes" && parts[3] === "sessions";
    if (!isSessionPath) {
        return false;
    }
    return parts.length === 5 || url.searchParams.getAll("sessionId").length > 0;
}

export async function routeProjectDurableObject(
    request: Request,
    bindings: ProjectDurableObjectRoutingBindings,
    allowedOrigins: ReadonlySet<string>,
): Promise<Response | null> {
    if ("MOBIUS_PROJECT_DATABASE" in bindings) {
        return null;
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === `${MOBIUS_API_PREFIX}/dashboard` || pathname.startsWith(`${MOBIUS_API_PREFIX}/dashboard/`)) {
        return null;
    }
    if (pathname.includes("/recording/sessions") || isRecordingSessionStatusRead(request)) {
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
}
