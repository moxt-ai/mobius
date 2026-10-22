import {
    decodeSessionAccessCredential,
    isIdentifier,
    MOBIUS_API_PREFIX,
    ProtocolMessageError,
} from "@moxt-ai/mobius-sdk/protocol";
import type { PlatformRelayBindings, RuntimeExecutionBindings } from "../platform-worker.ts";

/** Unverified claims select a destination only. The destination authorizes the complete request. */
export function runtimeRequestTarget(
    request: Request,
): { readonly projectId: string; readonly runtimeId: string } | null {
    const url = new URL(request.url);
    const prefix = `${MOBIUS_API_PREFIX}/v1/projects/`;
    if (!url.pathname.startsWith(prefix)) {
        return null;
    }
    const parts = url.pathname.slice(prefix.length).split("/");
    const projectId = parts[0];
    if (!isIdentifier(projectId)) {
        return null;
    }
    if (parts[1] === "runtimes" && isIdentifier(parts[2])) {
        return { projectId, runtimeId: parts[2] };
    }
    if (parts[1] !== "sessions" || parts.length < 4 || parts[3] === "access-credentials") {
        return null;
    }
    const credential =
        (request.headers.get("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1] ?? url.searchParams.get("token");
    if (credential === null) {
        return null;
    }
    try {
        return { projectId, runtimeId: decodeSessionAccessCredential(credential).claims.runtimeId };
    } catch (cause) {
        if (cause instanceof ProtocolMessageError) {
            return null;
        }
        throw cause;
    }
}

export async function routeRuntimeSessionRequest(
    request: Request,
    environment: PlatformRelayBindings | RuntimeExecutionBindings,
): Promise<Response | null> {
    if ("MOBIUS_RUNTIME_EXECUTION" in environment) {
        return null;
    }
    const target = runtimeRequestTarget(request);
    if (target === null) {
        return null;
    }
    return await environment.RUNTIME_RELAY.getByName(target.runtimeId).fetch(request);
}
