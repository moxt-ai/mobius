import { runtimeRequestTarget } from "@moxt-ai/mobius-sdk/platform";
import type { PlatformRelayBindings, RuntimeExecutionBindings } from "../platform-worker.ts";

export { runtimeRequestTarget };

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
