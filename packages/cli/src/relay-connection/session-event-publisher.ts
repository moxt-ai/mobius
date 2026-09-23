import {
    AGENT_ACTIVITY_KIND,
    AGENT_ACTIVITY_NARRATION_KIND,
    type decodeSessionEventDeferred,
    decodeSessionEventEnvelope,
    encodeDaemonToServiceMessage,
    encodeRecordedSessionEvent,
    type RecordedSessionEvent,
    SESSION_COMPLETED_KIND,
    SESSION_FAILED_KIND,
    type SessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import { WebSocket } from "undici";

import { type SessionEventOutbox, SessionEventOutboxCapacityError } from "./session-event-outbox.ts";
import type { DaemonScheduledTask, DaemonTimer } from "./timer.ts";

abstract class DaemonSessionEventConnectionState {
    abstract readonly disconnect: (socket: WebSocket) => DaemonSessionEventConnectionState;
    abstract readonly matches: (socket: WebSocket) => boolean;
    abstract readonly send: (message: SessionEventEnvelope) => boolean;
}

class DisconnectedDaemonSessionEventState extends DaemonSessionEventConnectionState {
    readonly disconnect = (): DaemonSessionEventConnectionState => this;
    readonly matches = (): boolean => false;
    readonly send = (): boolean => false;
}

class ConnectedDaemonSessionEventState extends DaemonSessionEventConnectionState {
    readonly #socket: WebSocket;

    constructor(socket: WebSocket) {
        super();
        this.#socket = socket;
    }

    readonly disconnect = (socket: WebSocket): DaemonSessionEventConnectionState =>
        socket === this.#socket ? new DisconnectedDaemonSessionEventState() : this;

    readonly matches = (socket: WebSocket): boolean => socket === this.#socket;

    readonly send = (message: SessionEventEnvelope): boolean => {
        if (this.#socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.#socket.send(encodeDaemonToServiceMessage(message));
            return true;
        } catch {
            // The in-memory outbox retains the event for the replacement connection.
            return false;
        }
    };
}

const SESSION_EVENT_REPLAY_WINDOW = 16;
const SESSION_EVENT_SOURCE_REPLAY_WINDOW = 4;
const SESSION_EVENT_REPLAY_BYTE_LIMIT = 32 * 1024 * 1024;
/**
 * Events that settle a Turn reserve capacity streaming events cannot consume. A
 * completed narrative activity carries the text that supersedes its increments, so it
 * is the only event that can settle a streamed narration; without the reservation the
 * snapshot could be shed after its increments were, losing the text entirely.
 */
function reservesSessionEventCapacity(event: RecordedSessionEvent): boolean {
    if (event.kind === SESSION_COMPLETED_KIND || event.kind === SESSION_FAILED_KIND) {
        return true;
    }
    return (
        event.kind === AGENT_ACTIVITY_KIND &&
        (event.activityType === "progress" || event.activityType === "reasoning") &&
        (event.status === "completed" || event.status === "failed")
    );
}

class InFlightSessionEvent {
    readonly byteLength: number;
    readonly sourceKey: string;

    constructor(sourceKey: string, byteLength: number) {
        this.byteLength = byteLength;
        this.sourceKey = sourceKey;
    }
}

function sessionEventSourceKey(envelope: ReturnType<typeof decodeSessionEventEnvelope>): string {
    return envelope.source.kind === "attempt"
        ? `attempt:${envelope.sessionId}:${envelope.source.attemptId}`
        : `runtime:${envelope.sessionId}`;
}

export class DaemonSessionEventPublisher {
    readonly #outbox: SessionEventOutbox;
    readonly #inFlightEvents = new Map<string, InFlightSessionEvent>();
    readonly #pausedSources = new Map<string, DaemonScheduledTask>();
    readonly #shedEventKinds = new Set<string>();
    readonly #timer: DaemonTimer;
    #inFlightBytes = 0;
    #connection: DaemonSessionEventConnectionState = new DisconnectedDaemonSessionEventState();

    constructor(outbox: SessionEventOutbox, timer: DaemonTimer) {
        this.#outbox = outbox;
        this.#timer = timer;
    }

    readonly connect = (socket: WebSocket): void => {
        this.#connection = new ConnectedDaemonSessionEventState(socket);
        this.#clearInFlight();
        this.#publishNextBatch();
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (!this.#connection.matches(socket)) {
            return;
        }
        this.#connection = this.#connection.disconnect(socket);
        this.#clearInFlight();
    };

    readonly recordAttempt = (sessionId: string, event: RecordedSessionEvent, attemptId: string): void => {
        const encoded = encodeRecordedSessionEvent(event);
        if (reservesSessionEventCapacity(event)) {
            this.#enqueueReserved(sessionId, encoded, attemptId, event.kind);
        } else {
            this.#enqueueStandard(sessionId, encoded, attemptId, event.kind);
        }
        this.#publishNextBatch();
    };

    readonly recordRuntime = (sessionId: string, event: RecordedSessionEvent): void => {
        this.#enqueueStandard(sessionId, encodeRecordedSessionEvent(event), "", event.kind);
        this.#publishNextBatch();
    };

    /**
     * Enqueue a standard event, shedding it instead of ending the daemon when the
     * in-memory outbox is full.
     *
     * A capacity error used to escape the coalescing timer that publishes activities,
     * so the process exited and every restart died on the same retained backlog. A full
     * outbox is a recoverable runtime condition, not a fatal one: narration increments are
     * superseded by the completed snapshot, so they are shed first, and any other streaming
     * event is shed only at the wall rather than terminating the daemon.
     */
    readonly #enqueueStandard = (sessionId: string, encoded: string, attemptId: string, kind: string): void => {
        if (kind === AGENT_ACTIVITY_NARRATION_KIND && this.#outbox.standardCapacityRemaining() <= 0) {
            this.#reportShedEvent(kind);
            return;
        }
        try {
            this.#outbox.enqueue(sessionId, encoded, attemptId);
        } catch (error) {
            if (!(error instanceof SessionEventOutboxCapacityError)) {
                throw error;
            }
            this.#reportShedEvent(kind);
        }
    };

    /**
     * Enqueue on the reserved budget, degrading to a reported drop instead of raising.
     * Streaming events are shed before this budget is reached, so a Turn's terminal
     * events and the completed snapshot that carries its narration still land; a drop
     * here is the last resort for a backlog no acknowledgement can drain.
     */
    readonly #enqueueReserved = (sessionId: string, encoded: string, attemptId: string, kind: string): void => {
        try {
            this.#outbox.enqueueCritical(sessionId, encoded, attemptId);
        } catch (error) {
            if (!(error instanceof SessionEventOutboxCapacityError)) {
                throw error;
            }
            this.#reportShedEvent(kind);
        }
    };

    readonly #reportShedEvent = (kind: string): void => {
        if (this.#shedEventKinds.has(kind)) {
            return;
        }
        this.#shedEventKinds.add(kind);
        console.warn(`Mobius daemon is dropping queued "${kind}" events because the Session event outbox is full`);
    };

    readonly acknowledge = (acknowledgement: Parameters<SessionEventOutbox["acknowledge"]>[0]): void => {
        if (!this.#outbox.acknowledge(acknowledgement)) {
            return;
        }
        this.#removeInFlight(acknowledgement.eventId);
        this.#publishNextBatch();
    };

    readonly quarantine = (rejection: Parameters<SessionEventOutbox["quarantine"]>[0]): boolean => {
        const quarantined = this.#outbox.quarantine(rejection);
        if (!quarantined) {
            return false;
        }
        this.#removeInFlight(rejection.eventId);
        this.#publishNextBatch();
        return true;
    };

    readonly defer = (deferred: ReturnType<typeof decodeSessionEventDeferred>): void => {
        const inFlight = this.#inFlightEvents.get(deferred.eventId);
        if (inFlight === undefined) {
            return;
        }
        this.#clearInFlightSource(inFlight.sourceKey);
        if (!this.#pausedSources.has(inFlight.sourceKey)) {
            this.#pausedSources.set(
                inFlight.sourceKey,
                this.#timer.schedule(() => {
                    this.#pausedSources.delete(inFlight.sourceKey);
                    this.#publishNextBatch();
                }, deferred.retryAfterMilliseconds),
            );
        }
        this.#publishNextBatch();
    };

    readonly close = (): void => {
        for (const task of this.#pausedSources.values()) {
            task.cancel();
        }
        this.#pausedSources.clear();
        this.#clearInFlight();
    };

    readonly #publishNextBatch = (): void => {
        while (this.#inFlightEvents.size < SESSION_EVENT_REPLAY_WINDOW) {
            const sourceCounts = new Map<string, number>();
            for (const inFlight of this.#inFlightEvents.values()) {
                sourceCounts.set(inFlight.sourceKey, (sourceCounts.get(inFlight.sourceKey) ?? 0) + 1);
            }
            const saturatedSources = [...sourceCounts.entries()]
                .filter(([, count]) => count >= SESSION_EVENT_SOURCE_REPLAY_WINDOW)
                .map(([sourceKey]) => sourceKey);
            const batch = this.#outbox.pendingSourceHeads(
                SESSION_EVENT_REPLAY_WINDOW - this.#inFlightEvents.size,
                [...this.#inFlightEvents.keys()],
                [...this.#pausedSources.keys(), ...saturatedSources],
            );
            let sent = 0;
            for (const encoded of batch) {
                const envelope = decodeSessionEventEnvelope(encoded);
                const sourceKey = sessionEventSourceKey(envelope);
                const sourceCount = sourceCounts.get(sourceKey) ?? 0;
                if (sourceCount >= SESSION_EVENT_SOURCE_REPLAY_WINDOW) {
                    continue;
                }
                const byteLength = new TextEncoder().encode(encoded).byteLength;
                if (this.#inFlightBytes + byteLength > SESSION_EVENT_REPLAY_BYTE_LIMIT) {
                    continue;
                }
                if (!this.#connection.send(envelope)) {
                    this.#clearInFlight();
                    return;
                }
                this.#inFlightEvents.set(envelope.eventId, new InFlightSessionEvent(sourceKey, byteLength));
                this.#inFlightBytes += byteLength;
                sourceCounts.set(sourceKey, sourceCount + 1);
                sent += 1;
            }
            if (sent === 0) {
                return;
            }
        }
    };

    readonly #removeInFlight = (eventId: string): void => {
        const inFlight = this.#inFlightEvents.get(eventId);
        if (inFlight === undefined) {
            return;
        }
        this.#inFlightEvents.delete(eventId);
        this.#inFlightBytes -= inFlight.byteLength;
    };

    readonly #clearInFlight = (): void => {
        this.#inFlightEvents.clear();
        this.#inFlightBytes = 0;
    };

    readonly #clearInFlightSource = (sourceKey: string): void => {
        for (const [eventId, inFlight] of this.#inFlightEvents) {
            if (inFlight.sourceKey !== sourceKey) {
                continue;
            }
            this.#inFlightEvents.delete(eventId);
            this.#inFlightBytes -= inFlight.byteLength;
        }
    };
}
