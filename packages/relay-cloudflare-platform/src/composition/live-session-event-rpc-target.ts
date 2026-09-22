import { RpcTarget } from "cloudflare:workers";
import type { SessionEventReceiver } from "@moxt-ai/mobius-relay-core";

class LiveSessionEventRpcTarget extends RpcTarget implements SessionEventReceiver {
    readonly #receiver: SessionEventReceiver;

    constructor(receiver: SessionEventReceiver) {
        super();
        this.#receiver = receiver;
    }

    async receive(message: Parameters<SessionEventReceiver["receive"]>[0]): Promise<void> {
        await this.#receiver.receive(message);
    }
}

export const createLiveSessionEventRpcTarget = (receiver: SessionEventReceiver): SessionEventReceiver =>
    new LiveSessionEventRpcTarget(receiver);
