import { describe, expect, it } from "vitest";
import { decodeInteraction, decodeTurn } from "../../src/protocol/index.ts";

describe("Mobius resource contract", () => {
    it("Given a persisted Turn page, When a caller decodes it, Then every terminal state round-trips", () => {
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
            expect(decoded.state.kind).toBe(state.kind);
        }
        const queued = decodeTurn({
            ...turn,
            request: { content: "hello", kind: "prompt", sessionConfigurations: [] },
            state: { kind: "queued" },
        });
        expect(queued.request.kind).toBe("prompt");
    });

    it("Given an Interaction snapshot, When a caller decodes it, Then the request and response states round-trip", () => {
        const interaction = decodeInteraction({
            attemptId: "attempt-a",
            interactionId: "interaction-a",
            request: {
                kind: "permission",
                options: [
                    { kind: "allow_once", name: "Allow", optionId: "option-allow" },
                    { kind: "reject_once", name: "Reject", optionId: "option-reject" },
                ],
                title: "Run the tool",
                toolCallId: "tool-call-a",
                toolKind: "bash",
            },
            sessionId: "session-a",
            state: {
                kind: "responded",
                respondedAt: "2026-09-07T00:00:02.000Z",
                responderId: "responder-a",
                response: { content: "allowed", kind: "permission" },
            },
            turnId: "turn-a",
        });
        expect(interaction.state.kind).toBe("responded");
        expect(interaction.request.kind).toBe("permission");
    });
});
