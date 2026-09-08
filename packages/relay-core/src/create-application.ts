import { MOBIUS_API_PREFIX, parseMobiusApiPrefix } from "@moxt-ai/mobius-protocol";
import { createInjector } from "typed-inject";

import { MobiusApplication } from "./app.ts";
import { ChannelController } from "./controller/channel/channel-controller.ts";
import { HealthController } from "./controller/health/health-controller.ts";
import { PairingController } from "./controller/pairing/pairing-controller.ts";
import { SessionController } from "./controller/session/session-controller.ts";
import type {
    ChannelGateway,
    PairingGateway,
    SessionArtifactGateway,
    SessionCommandGateway,
    SessionEventStreamGateway,
    SessionQueryGateway,
    SessionTransferGateway,
} from "./gateway/index.ts";
import { ChannelService } from "./service/channel/channel-service.ts";
import { PairingService } from "./service/pairing/pairing-service.ts";
import { SessionService } from "./service/session/session-service.ts";

export interface MobiusApplicationEnvironment {
    readonly channelGateway: ChannelGateway;
    readonly pairingGateway: PairingGateway;
    readonly sessionCommands: SessionCommandGateway;
    readonly sessionQueries: SessionQueryGateway;
    readonly sessionTransfers: SessionTransferGateway;
    readonly sessionArtifacts: SessionArtifactGateway;
    readonly sessionEventStreams: SessionEventStreamGateway;
}

export function createMobiusApplication(
    environment: MobiusApplicationEnvironment,
    apiPrefix: string = MOBIUS_API_PREFIX,
) {
    const injector = createInjector()
        // Configuration
        .provideValue("apiPrefix", parseMobiusApiPrefix(apiPrefix))
        .provideValue("nowEpochMilliseconds", () => Date.now())

        // Gateways
        .provideValue("channelGateway", environment.channelGateway)
        .provideValue("pairingGateway", environment.pairingGateway)
        .provideValue("sessionCommands", environment.sessionCommands)
        .provideValue("sessionQueries", environment.sessionQueries)
        .provideValue("sessionTransfers", environment.sessionTransfers)
        .provideValue("sessionArtifacts", environment.sessionArtifacts)
        .provideValue("sessionEventStreams", environment.sessionEventStreams);

    return {
        injector,
        create: (configured: typeof injector = injector) =>
            configured
                // Services
                .provideClass("pairings", PairingService)
                .provideClass("channels", ChannelService)
                .provideClass("sessions", SessionService)

                // Controllers
                .provideClass("healthController", HealthController)
                .provideClass("pairingController", PairingController)
                .provideClass("channelController", ChannelController)
                .provideClass("sessionController", SessionController)

                // Application
                .provideClass("application", MobiusApplication),
    };
}
