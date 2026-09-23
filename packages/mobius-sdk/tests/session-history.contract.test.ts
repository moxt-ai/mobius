import { describe, expect, it } from "vitest";

import {
    decodeMobiusMessagePage,
    decodeMobiusTurn,
    MobiusActivitySummary,
    MobiusMessage,
    type MobiusMessagePage,
} from "../src/resources.ts";

/**
 * A durable Session outlives the protocol revision that recorded it. When a stored step no longer matches
 * the shape the current SDK reads, restoring the conversation must keep every other message and step
 * readable instead of failing the whole page.
 */

function readableActivity(activityId: string, sequence: number) {
    return {
        activityId,
        activityType: "tool",
        attemptId: "restored-attempt",
        detailAvailability: "unrecorded",
        input: "{}",
        locations: [],
        name: "terminal",
        output: `output-${sequence.toString()}`,
        sequence,
        status: "completed",
        title: "Run terminal command",
        toolCallId: activityId,
        toolKind: "execute",
    };
}

function message(commandId: string, activities: readonly unknown[]) {
    return {
        activities,
        additionalDirectoryIds: [],
        agentId: "codex",
        attempt: {
            attemptId: "restored-attempt",
            completedAt: "2026-09-06T00:00:01.000Z",
            kind: "succeeded",
            startedAt: "2026-09-06T00:00:00.000Z",
            stopReason: "end_turn",
        },
        commandId,
        contents: [],
        createdAt: "2026-09-06T00:00:00.000Z",
        disposition: "reject",
        images: [],
        messageId: `assistant-${commandId}`,
        prompt: "Run the installer",
        resources: [],
        response: "Installer finished.",
        sessionId: "restored-session",
        targetCommandId: "",
        turnId: "",
    };
}

describe("restored Session history", () => {
    it("Given a terminal Turn request was not retained, When the SDK decodes its response, Then consumers can distinguish unavailable content from a retained empty prompt", () => {
        const resource = {
            acceptedAt: "2026-09-06T00:00:00.000Z",
            bindingId: "binding-a",
            idempotencyKey: "submit-a",
            sessionId: "session-a",
            state: { cancelledAt: "2026-09-06T00:00:01.000Z", kind: "cancelled" },
            turnId: "turn-a",
        };
        const notRetained = decodeMobiusTurn({ ...resource, request: { kind: "not_retained" } });
        expect(notRetained.request).toEqual({ kind: "not_retained" });
        expect(notRetained.content).toBe("");
        expect(notRetained.sessionConfigurations).toEqual([]);
        expect(notRetained.state.kind).toBe("cancelled");

        const retained = decodeMobiusTurn({ ...resource, request: { content: "", kind: "prompt" } });
        expect(retained.request).toEqual({ content: "", kind: "prompt", sessionConfigurations: [] });
        expect(retained.content).toBe("");

        const configured = decodeMobiusTurn({
            ...resource,
            request: {
                content: "Inspect the repository",
                kind: "prompt",
                sessionConfigurations: [
                    { booleanValue: false, configId: "model", value: "model-a", valueType: "select" },
                ],
            },
        });
        expect(configured.request.kind).toBe("prompt");
        expect(configured.content).toBe("Inspect the repository");
        expect(configured.sessionConfigurations).toEqual([
            { booleanValue: false, configId: "model", value: "model-a", valueType: "select" },
        ]);
        expect(() =>
            decodeMobiusTurn({ ...resource, request: { kind: "not_retained" }, state: { kind: "queued" } }),
        ).toThrow();
    });

    it("Given a stored step no longer matches the current shape, When the SDK decodes its message page, Then the readable message and steps survive", () => {
        const page = decodeMobiusMessagePage({
            lastCommittedSeq: "4",
            messages: [
                message("affected-command", [readableActivity("affected-activity", 0), { activityId: "" }]),
                message("healthy-command", [
                    readableActivity("healthy-activity", 0),
                    readableActivity("healthy-activity-2", 1),
                ]),
            ],
            nextCursor: null,
        });

        const affected = page.messages[0];
        const healthy = page.messages[1];
        if (!(affected instanceof MobiusMessage) || !(healthy instanceof MobiusMessage)) {
            throw new Error("Expected both restored messages to decode");
        }
        expect(affected.response).toBe("Installer finished.");
        expect(affected.activities).toHaveLength(1);
        expect(affected.activities[0]).toBeInstanceOf(MobiusActivitySummary);
        expect(affected.activities[0]).toMatchObject({ activityId: "affected-activity", output: "output-0" });
        expect(healthy.activities).toHaveLength(2);
        expect(healthy.activities.map((activity) => activity.activityId)).toEqual([
            "healthy-activity",
            "healthy-activity-2",
        ]);
    });

    it("Given a message page is well formed, When the SDK decodes it, Then every message and step is preserved in order", () => {
        const page: MobiusMessagePage = decodeMobiusMessagePage({
            lastCommittedSeq: "2",
            messages: [message("healthy-command", [readableActivity("healthy-activity", 0)])],
            nextCursor: "cursor-1",
        });

        expect(page.lastCommittedSequence).toBe("2");
        expect(page.nextCursor).toBe("cursor-1");
        expect(page.messages).toHaveLength(1);
        expect(page.messages[0]).toBeInstanceOf(MobiusMessage);
        expect(page.messages[0]?.activities).toHaveLength(1);
    });
});
