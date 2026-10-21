import { randomUUID } from "node:crypto";

import {
    RUNTIME_HEARTBEAT_KIND,
    type RuntimeHeartbeatAckEvent,
    type RuntimeHeartbeatEvent,
} from "@moxt-ai/mobius-sdk/protocol";

import type { ScheduledTask, Timer } from "./timer.ts";

const HEARTBEAT_ACK_TIMEOUT_MILLISECONDS = 10_000;
const HEARTBEAT_INTERVAL_MILLISECONDS = 20_000;

abstract class RelayLivenessState {}

class UnsupportedRelayLivenessState extends RelayLivenessState {}

class AwaitingHeartbeatAckState extends RelayLivenessState {
    readonly heartbeatId: string;
    readonly timeout: ScheduledTask;

    constructor(heartbeatId: string, timeout: ScheduledTask) {
        super();
        this.heartbeatId = heartbeatId;
        this.timeout = timeout;
    }
}

class WaitingForHeartbeatState extends RelayLivenessState {
    readonly schedule: ScheduledTask;

    constructor(schedule: ScheduledTask) {
        super();
        this.schedule = schedule;
    }
}

class FinishedRelayLivenessState extends RelayLivenessState {}

export interface RelayLivenessTransport {
    readonly send: (message: RuntimeHeartbeatEvent) => boolean;
    readonly unresponsive: (heartbeatId: string, timeoutMilliseconds: number) => void;
}

export class RelayConnectionLiveness {
    readonly #timer: Timer;
    readonly #transport: RelayLivenessTransport;
    #state: RelayLivenessState = new UnsupportedRelayLivenessState();

    constructor(timer: Timer, transport: RelayLivenessTransport) {
        this.#timer = timer;
        this.#transport = transport;
    }

    readonly acknowledge = (event: RuntimeHeartbeatAckEvent): void => {
        if (!(this.#state instanceof AwaitingHeartbeatAckState)) {
            throw new Error("Unexpected relay heartbeat acknowledgement");
        }
        if (event.heartbeatId !== this.#state.heartbeatId) {
            throw new Error("Relay acknowledged the wrong heartbeat");
        }
        this.#state.timeout.cancel();
        this.#state = new WaitingForHeartbeatState(
            this.#timer.schedule(this.#sendHeartbeat, HEARTBEAT_INTERVAL_MILLISECONDS),
        );
    };

    readonly close = (): void => {
        if (this.#state instanceof AwaitingHeartbeatAckState) {
            this.#state.timeout.cancel();
        } else if (this.#state instanceof WaitingForHeartbeatState) {
            this.#state.schedule.cancel();
        } else if (
            !(this.#state instanceof UnsupportedRelayLivenessState) &&
            !(this.#state instanceof FinishedRelayLivenessState)
        ) {
            throw new Error("Unknown relay liveness state");
        }
        this.#state = new FinishedRelayLivenessState();
    };

    readonly start = (): void => {
        if (this.#state instanceof UnsupportedRelayLivenessState) {
            this.#sendHeartbeat();
            return;
        }
        if (this.#state instanceof AwaitingHeartbeatAckState || this.#state instanceof WaitingForHeartbeatState) {
            return;
        }
        if (this.#state instanceof FinishedRelayLivenessState) {
            return;
        }
        throw new Error("Unknown relay liveness state");
    };

    readonly #handleTimeout = (): void => {
        if (this.#state instanceof FinishedRelayLivenessState) {
            return;
        }
        if (!(this.#state instanceof AwaitingHeartbeatAckState)) {
            throw new Error("Heartbeat timeout occurred in an invalid state");
        }
        const heartbeatId = this.#state.heartbeatId;
        this.#state.timeout.cancel();
        this.#state = new FinishedRelayLivenessState();
        this.#transport.unresponsive(heartbeatId, HEARTBEAT_ACK_TIMEOUT_MILLISECONDS);
    };

    readonly #sendHeartbeat = (): void => {
        if (this.#state instanceof WaitingForHeartbeatState) {
            this.#state.schedule.cancel();
        } else if (!(this.#state instanceof UnsupportedRelayLivenessState)) {
            if (this.#state instanceof FinishedRelayLivenessState) {
                return;
            }
            throw new Error("Heartbeat was scheduled in an invalid state");
        }
        const heartbeatId = randomUUID();
        this.#state = new AwaitingHeartbeatAckState(
            heartbeatId,
            this.#timer.schedule(this.#handleTimeout, HEARTBEAT_ACK_TIMEOUT_MILLISECONDS),
        );
        const sent = this.#transport.send({
            heartbeatId,
            kind: RUNTIME_HEARTBEAT_KIND,
        });
        if (!sent && this.#state instanceof AwaitingHeartbeatAckState && this.#state.heartbeatId === heartbeatId) {
            this.#state.timeout.cancel();
            this.#state = new FinishedRelayLivenessState();
        }
    };
}
