import { Hono } from "hono";

import type { ChannelController } from "./controller/channel/channel-controller.ts";
import type { HealthController } from "./controller/health/health-controller.ts";
import type { PairingController } from "./controller/pairing/pairing-controller.ts";
import type { SessionController } from "./controller/session/session-controller.ts";

export class MobiusApplication extends Hono {
    static readonly inject = [
        "apiPrefix",
        "healthController",
        "pairingController",
        "channelController",
        "sessionController",
    ] satisfies readonly [
        "apiPrefix",
        "healthController",
        "pairingController",
        "channelController",
        "sessionController",
    ];

    constructor(
        apiPrefix: string,
        health: HealthController,
        pairings: PairingController,
        channels: ChannelController,
        sessions: SessionController,
    ) {
        super();
        this.route(apiPrefix, health.routes);
        this.route(`${apiPrefix}/pairings`, pairings.routes);
        this.route(`${apiPrefix}/channels`, channels.routes);
        this.route(apiPrefix, sessions.routes);
    }
}
