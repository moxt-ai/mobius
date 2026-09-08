import { MOBIUS_API_PREFIX, parseMobiusApiPrefix } from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";

import { createChannelRoutes } from "./http/channel-routes.ts";
import { createPairingRoutes } from "./http/pairing-routes.ts";
import { createSessionRoutes } from "./http/session-routes.ts";
import { type RelayPorts, RelayUseCases } from "./relay-use-cases.ts";

export type RelayDependencies = RelayPorts;

export class MobiusApplication extends Hono {
    static readonly inject = ["useCases", "apiPrefix"] satisfies readonly ["useCases", "apiPrefix"];

    constructor(useCases: RelayUseCases, apiPrefix: string) {
        super();

        const api = new Hono();
        api.get("/health", (context) =>
            context.json({
                service: "mobius-relay",
                status: "ok",
            }),
        );
        api.route("/pairings", createPairingRoutes(useCases.pairings));
        api.route("/channels", createChannelRoutes(useCases.channels));
        api.route("/", createSessionRoutes(useCases.sessions));

        this.route(parseMobiusApiPrefix(apiPrefix), api);
    }
}

export function createRelayApp(dependencies: RelayDependencies, apiPrefix: string = MOBIUS_API_PREFIX): Hono {
    return new MobiusApplication(
        new RelayUseCases(dependencies.channelRuntime, dependencies.pairingDirectory, dependencies.sessionRuntime),
        apiPrefix,
    );
}
