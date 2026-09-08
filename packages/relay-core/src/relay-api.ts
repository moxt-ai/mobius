import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { createMobiusApplication } from "./app.ts";
import { createMobiusDependencies, type RelayDependencies, relayInfrastructure } from "./create-dependencies.ts";

export type { RelayDependencies } from "./create-dependencies.ts";

export function createRelayApp(dependencies: RelayDependencies, apiPrefix: string = MOBIUS_API_PREFIX) {
    const cx = createMobiusDependencies(relayInfrastructure(dependencies, apiPrefix));
    const application = createMobiusApplication(cx.config.apiPrefix);
    return Object.freeze({ fetch: async (request: Request) => await application.fetch(request, cx) });
}
