import { describe, expect, it } from "vitest";

import { RelayConnectionLiveness } from "../src/relay-connection/liveness.ts";
import type { DaemonScheduledTask, DaemonTimer } from "../src/relay-connection/timer.ts";

class RecordedTask implements DaemonScheduledTask {
    readonly #callback: () => void;
    #cancelled = false;

    constructor(callback: () => void) {
        this.#callback = callback;
    }

    readonly cancel = (): void => {
        this.#cancelled = true;
    };

    readonly run = (): void => {
        if (this.#cancelled) {
            return;
        }
        this.#cancelled = true;
        this.#callback();
    };
}

class RecordingTimer implements DaemonTimer {
    readonly #tasks = new Map<number, RecordedTask[]>();

    readonly schedule = (callback: () => void, milliseconds: number): DaemonScheduledTask => {
        const task = new RecordedTask(callback);
        const tasks = this.#tasks.get(milliseconds) ?? [];
        tasks.push(task);
        this.#tasks.set(milliseconds, tasks);
        return task;
    };

    readonly take = (milliseconds: number): RecordedTask => {
        const task = this.#tasks.get(milliseconds)?.shift();
        if (task === undefined) {
            throw new Error(`Expected a ${milliseconds.toString()}ms task`);
        }
        return task;
    };
}

describe("relay liveness transport contract", () => {
    it("Given the relay socket is already closed, When liveness starts a heartbeat, Then it cancels the acknowledgement deadline without reporting a timeout", () => {
        const timer = new RecordingTimer();
        const unresponsiveHeartbeatIds: string[] = [];
        let sent = 0;
        const liveness = new RelayConnectionLiveness(timer, {
            send: () => {
                sent += 1;
                return false;
            },
            unresponsive: (heartbeatId) => {
                unresponsiveHeartbeatIds.push(heartbeatId);
            },
        });

        liveness.start();
        timer.take(10_000).run();
        liveness.start();

        expect(sent).toBe(1);
        expect(unresponsiveHeartbeatIds).toEqual([]);
    });
});
