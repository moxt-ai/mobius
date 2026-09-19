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

    get pending(): number {
        return this.#callbacks.size;
    }
}

describe("coalescing assistant text publisher", () => {
    it("Given token-level deltas arrive faster than the flush interval, When the timer fires, Then the buffered text is published as one event", () => {
        const timer = new ManualTimer();
        const events: [string, string][] = [];
        const publisher = new CoalescingTextPublisher(
            timer,
            (messageId, text) => events.push([messageId, text]),
            100,
            100_000,
        );

        for (const token of ["La", "sa", " ph", "ot", "ov"]) {
            publisher.record("message-1", token);
        }

        expect(events).toHaveLength(0);
        timer.fire();
        expect(events).toEqual([["message-1", "Lasa photov"]]);
    });

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

    it("Given no text is buffered, When flush is called, Then nothing is published", () => {
        const timer = new ManualTimer();
        const events: [string, string][] = [];
        const publisher = new CoalescingTextPublisher(
            timer,
            (messageId, text) => events.push([messageId, text]),
            100,
            100_000,
        );

        publisher.flush();

        expect(events).toEqual([]);
    });

    it("Given empty deltas are recorded, When the timer fires, Then no event is published", () => {
        const timer = new ManualTimer();
        const events: [string, string][] = [];
        const publisher = new CoalescingTextPublisher(
            timer,
            (messageId, text) => events.push([messageId, text]),
            100,
            100_000,
        );

        publisher.record("message-1", "");
        timer.fire();

        expect(events).toEqual([]);
        expect(timer.pending).toBe(0);
    });

    it("Given the buffer was flushed, When more deltas arrive, Then they schedule a fresh flush rather than publishing immediately", () => {
        const timer = new ManualTimer();
        const events: [string, string][] = [];
        const publisher = new CoalescingTextPublisher(
            timer,
            (messageId, text) => events.push([messageId, text]),
            100,
            100_000,
        );

        publisher.record("message-1", "a");
        timer.fire();
        publisher.record("message-1", "b");

        expect(events).toEqual([["message-1", "a"]]);
        expect(timer.pending).toBe(1);
        timer.fire();
        expect(events).toEqual([
            ["message-1", "a"],
            ["message-1", "b"],
        ]);
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
