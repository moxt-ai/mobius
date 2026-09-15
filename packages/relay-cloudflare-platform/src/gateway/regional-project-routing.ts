import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";

export interface RegionalProjectBindings {
    readonly MOBIUS_WORKER_REGION?: unknown;
    readonly MOBIUS_REGIONAL_APAC?: unknown;
    readonly MOBIUS_REGIONAL_WNAM?: unknown;
}

function failure(code: string, status: number): Response {
    return Response.json({ error: { code, message: "Regional Project routing is unavailable" } }, { status });
}

export async function routeRegionalProject(
    request: Request,
    bindings: RegionalProjectBindings,
): Promise<Response | null> {
    const region = bindings.MOBIUS_WORKER_REGION;
    if (region === undefined) {
        return null;
    }
    if (region !== "edge" && region !== "apac" && region !== "wnam") {
        return failure("regional_configuration_invalid", 503);
    }
    const prefix = `${MOBIUS_API_PREFIX}/v1/projects/`;
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) {
        return null;
    }
    let projectId: string;
    try {
        projectId = decodeURIComponent(path.slice(prefix.length).split("/")[0] ?? "");
    } catch {
        return failure("project_id_invalid", 400);
    }
    const placement = decodePlatformProjectPlacement(projectId);
    if (placement === null) {
        return failure("project_id_invalid", 400);
    }
    const destination = placement.r2BucketId;
    if (region !== "edge") {
        return region === destination ? null : failure("project_region_mismatch", 421);
    }
    const target = destination === "apac" ? bindings.MOBIUS_REGIONAL_APAC : bindings.MOBIUS_REGIONAL_WNAM;
    if (typeof target !== "object" || target === null || !("fetch" in target) || typeof target.fetch !== "function") {
        return failure("regional_backend_unavailable", 503);
    }
    request.signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 120_000);
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    let abort = () => {};
    try {
        const response: unknown = await Promise.race([
            target.fetch(new Request(request, { signal })),
            new Promise<never>((_resolve, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) {
                    abort();
                }
            }),
        ]);
        signal.throwIfAborted();
        return response instanceof Response ? response : failure("regional_backend_unavailable", 503);
    } catch {
        request.signal.throwIfAborted();
        return failure(
            deadline.signal.aborted ? "regional_backend_timeout" : "regional_backend_unavailable",
            deadline.signal.aborted ? 504 : 503,
        );
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
    }
}
