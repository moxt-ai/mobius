import { describe, expect, it } from "vitest";

import { CoalescingTextPublisher } from "../src/relay-connection/coalescing-text-publisher.ts";
import type { DaemonScheduledTask, DaemonTimer } from "../src/relay-connection/timer.ts";

/** Deterministic timer that only fires when the test advances it. */
class ManualTimer implements DaemonTimer {
    readonly #callbacks = new Map<number, () => void>();
    #nextId = 1;

    readonly schedule = (callback: () => void, _milliseconds: number): DaemonScheduledTask => {
        const id = this.#nextId;
        this.#nextId += 1;
        this.#callbacks.set(id, callback);
        return {
            cancel: () => {
                this.#callbacks.delete(id);
            },
        };
    };

    readonly fire = (): void => {
        const callbacks = [...this.#callbacks.values()];
        this.#callbacks.clear();
        for (const callback of callbacks) {
            callback();
        }
    };
}

describe("coalescing assistant text publisher", () => {
    it("Given deltas from a new message arrive, When the message id changes, Then the buffered text is published before the new message buffers", () => {
        const timer = new ManualTimer();
        const events: [string, string][] = [];
        const publisher = new CoalescingTextPublisher(
            timer,
            (messageId, text) => events.push([messageId, text]),
            100,
            100_000,
        );

        publisher.record("message-1", "first");
        publisher.record("message-2", "second");

        expect(events).toEqual([["message-1", "first"]]);

        timer.fire();
        expect(events).toEqual([
            ["message-1", "first"],
            ["message-2", "second"],
        ]);
    });

    it("Given buffered text is pending, When flush is called, Then the text is published immediately without waiting for the timer", () => {
        const timer = new ManualTimer();
        const events: [string, string][] = [];
        const publisher = new CoalescingTextPublisher(
            timer,
            (messageId, text) => events.push([messageId, text]),
            100,
            100_000,
        );

        publisher.record("message-1", "tail");
        publisher.flush();

        expect(events).toEqual([["message-1", "tail"]]);
        timer.fire();
        expect(events).toEqual([["message-1", "tail"]]);
    });

    it("Given buffered text would exceed the per-event limit, When another delta arrives, Then the buffer flushes so no event exceeds the limit", () => {
        const timer = new ManualTimer();
        const events: [string, string][] = [];
        const publisher = new CoalescingTextPublisher(
            timer,
            (messageId, text) => events.push([messageId, text]),
            100,
            10,
        );

        publisher.record("message-1", "abcdefgh");
        publisher.record("message-1", "ijk");

        expect(events).toEqual([["message-1", "abcdefgh"]]);

        timer.fire();
        expect(events).toEqual([
            ["message-1", "abcdefgh"],
            ["message-1", "ijk"],
        ]);
        for (const [, text] of events) {
            expect(text.length).toBeLessThanOrEqual(10);
        }
    });
});
