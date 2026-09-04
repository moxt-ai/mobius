import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChannelHistory,
  CompletedRecordedTurn,
  PendingRecordedTurn,
} from "@/domain/channel";
import {
  ChannelHistorySynchronizer,
  type ChannelHistorySynchronizerPort,
} from "@/services/channel-history-synchronizer";

class StatefulHistoryPort implements ChannelHistorySynchronizerPort {
  readonly applied: ChannelHistory[] = [];
  readonly failures: unknown[] = [];
  readonly responses: readonly ChannelHistory[];
  reads = 0;

  constructor(responses: readonly ChannelHistory[]) {
    this.responses = responses;
  }

  readonly applyHistory = (history: ChannelHistory): void => {
    this.applied.push(history);
  };

  readonly hasActiveTurns = (): boolean => {
    const latest = this.applied.at(-1);
    if (latest === undefined) {
      return false;
    }
    return latest.turns.some(
      (turn) => turn.status === "pending" || turn.status === "running",
    );
  };

  readonly readHistory = (): Promise<ChannelHistory> => {
    const response = this.responses[this.reads];
    this.reads += 1;
    if (response === undefined) {
      return Promise.reject(new Error("Unexpected history read"));
    }
    return Promise.resolve(response);
  };

  readonly reportFailure = (error: unknown): void => {
    this.failures.push(error);
  };
}

class CancellableHistoryPort implements ChannelHistorySynchronizerPort {
  aborted = false;
  readonly failures: unknown[] = [];
  reads = 0;

  readonly applyHistory = (): void => {
    throw new Error("Cancelled history must not be applied");
  };

  readonly hasActiveTurns = (): boolean => false;

  readonly readHistory = (signal: AbortSignal): Promise<ChannelHistory> => {
    this.reads += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          reject(new Error("History read aborted"));
        },
        { once: true },
      );
    });
  };

  readonly reportFailure = (error: unknown): void => {
    this.failures.push(error);
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Channel history synchronization", () => {
  it("Given another browser starts a task, When activity arrives, Then pending state refreshes until the task completes", async () => {
    vi.useFakeTimers();
    const pending = new ChannelHistory([
      new PendingRecordedTurn(
        "codex",
        "command",
        new Date("2026-09-04T02:00:00.000Z"),
        "task",
        "",
        "session",
      ),
    ]);
    const completed = new ChannelHistory([
      new CompletedRecordedTurn(
        "codex",
        "command",
        new Date("2026-09-04T02:00:00.000Z"),
        "task",
        "done",
        "session",
        "attempt",
        "end_turn",
      ),
    ]);
    const port = new StatefulHistoryPort([pending, completed]);
    const synchronizer = new ChannelHistorySynchronizer(port);
    synchronizer.start();

    synchronizer.notifyActivity();
    await vi.advanceTimersByTimeAsync(250);

    expect(port.reads).toBe(1);
    expect(port.applied).toEqual([pending]);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(port.reads).toBe(2);
    expect(port.applied).toEqual([pending, completed]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(port.reads).toBe(2);
    expect(port.failures).toEqual([]);

    synchronizer.stop();
  });

  it("Given an active refresh timer, When synchronization stops, Then no later history read runs", async () => {
    vi.useFakeTimers();
    const port = new StatefulHistoryPort([new ChannelHistory([])]);
    const synchronizer = new ChannelHistorySynchronizer(port);
    synchronizer.start();
    synchronizer.notifyActivity();

    synchronizer.stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(port.reads).toBe(0);
  });

  it("Given a history request is in flight, When synchronization stops, Then the request is cancelled without surfacing an error", async () => {
    vi.useFakeTimers();
    const port = new CancellableHistoryPort();
    const synchronizer = new ChannelHistorySynchronizer(port);
    synchronizer.start();
    synchronizer.notifyActivity();
    await vi.advanceTimersByTimeAsync(250);

    expect(port.reads).toBe(1);
    synchronizer.stop();
    await Promise.resolve();

    expect(port.aborted).toBe(true);
    expect(port.failures).toEqual([]);
  });
});
