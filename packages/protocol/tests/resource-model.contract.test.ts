import { describe, expect, it } from "vitest";
import { decodeAttempt, decodeTurn, transitionAttempt, transitionTurn } from "../src/index.ts";

describe("Mobius resource lifecycle contract", () => {
    it("Given a terminal Turn without retained content, When a caller queues it again, Then the lifecycle transition is rejected", () => {
        const turn = {
            acceptedAt: "2026-09-07T00:00:01.000Z",
            bindingId: "binding-a",
            idempotencyKey: "submit-a",
            request: { kind: "not_retained" },
            sessionId: "session-a",
            turnId: "turn-a",
        };
        const terminalStates = [
            {
                completedAt: "2026-09-07T00:00:03.000Z",
                kind: "succeeded",
                result: { kind: "agent_result", stopReason: "end_turn" },
            },
            {
                error: { code: "agent_failed", message: "The Agent failed", retryable: false },
                failedAt: "2026-09-07T00:00:03.000Z",
                kind: "failed",
            },
            { cancelledAt: "2026-09-07T00:00:03.000Z", kind: "cancelled" },
        ];
        for (const state of terminalStates) {
            const decoded = decodeTurn({ ...turn, state });
            expect(() => transitionTurn(decoded, { kind: "queued" })).toThrowError(
                expect.objectContaining({ code: "invalid_resource_transition" }),
            );
        }
    });

    it("Given a terminal Attempt, When a caller requests a backward lifecycle transition, Then the explicit transition contract rejects it", () => {
        const attempt = decodeAttempt({
            attemptId: "attempt-terminal",
            bindingId: "binding-a",
            sessionId: "session-a",
            state: {
                completedAt: "2026-09-07T00:00:03.000Z",
                kind: "succeeded",
                result: { kind: "agent_result", stopReason: "end_turn" },
                startedAt: "2026-09-07T00:00:02.000Z",
            },
            turnId: "turn-a",
        });
        expect(() =>
            transitionAttempt(attempt, {
                kind: "running",
                startedAt: "2026-09-07T00:00:04.000Z",
            }),
        ).toThrowError(expect.objectContaining({ code: "invalid_resource_transition" }));
        expect(() =>
            transitionAttempt(attempt, {
                completedAt: "2026-09-07T00:00:04.000Z",
                kind: "succeeded",
                result: { kind: "agent_result", stopReason: "changed_result" },
                startedAt: "2026-09-07T00:00:02.000Z",
            }),
        ).toThrowError(expect.objectContaining({ code: "invalid_resource_transition" }));
    });
});
