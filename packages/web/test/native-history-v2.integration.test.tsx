import {
    type AcpSessionUpdateV2,
    decodeFileReadCommand,
    decodeSessionPrepareCommand,
    encodeDaemonToServiceMessage,
    encodeFileBeginEvent,
    encodeFileChunkEvent,
    encodeFileEndEvent,
    FILE_READ_KIND,
    SESSION_PREPARE_KIND,
} from "@moxt-ai/mobius-protocol";
import { cleanup, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    completeRenderedPrompt,
    createTestApplication,
    openReadyApplication,
    sendReadySession,
    setupWebIntegrationEnvironment,
    waitForDocumentState,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();
it("Given a native conversation on a V2-only daemon, When a user reopens it, Then the previous reply appears and the composer becomes ready", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-09T00:00:00Z"), toFake: ["Date"] });
    const paired = await openReadyApplication();
    try {
        await completeRenderedPrompt(paired.daemon, "Remember this conversation", "The previous answer is available.");
        cleanup();
        await closeMobiusTransport();
        createTestApplication();
        const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND, signal));
        await sendReadySession(paired.daemon, prepare);
        await waitForDocumentState(() => screen.queryByText("The previous answer is available.") !== null, signal);
        expect(screen.getByText("The previous answer is available.")).toBeTruthy();
        expect(screen.getByRole("combobox", { name: "Message the local agent" })).toBeTruthy();
    } finally {
        await paired.close();
        vi.useRealTimers();
    }
});

it("Given a long native conversation with tool activity and an external image, When a user reopens it, Then recent content and the pulled image appear with an earlier-history notice", async ({
    signal,
}) => {
    vi.useFakeTimers({ now: new Date("2026-10-09T00:00:00Z"), toFake: ["Date"] });
    const paired = await openReadyApplication();
    try {
        const prompt = await completeRenderedPrompt(paired.daemon, "Create a picture", "Done");
        const updates: readonly AcpSessionUpdateV2[] = [
            ...Array.from(
                { length: 205 },
                (_, index): AcpSessionUpdateV2 => ({
                    sessionUpdate: "agent_message_chunk",
                    messageId: `answer-${index}`,
                    content: { type: "text", text: `Previous answer ${index}` },
                }),
            ),
            { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Check the workspace first" } },
            {
                sessionUpdate: "tool_call",
                toolCallId: "inspect-workspace",
                title: "Inspect workspace",
                kind: "read",
                status: "pending",
                rawInput: { path: "image.png" },
            },
            {
                sessionUpdate: "agent_message_chunk",
                messageId: "final-answer",
                content: { type: "text", text: "The picture is ready" },
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "inspect-workspace",
                status: "completed",
                rawOutput: "Read successfully",
            },
            {
                sessionUpdate: "agent_message_chunk",
                messageId: "final-answer",
                content: {
                    type: "external_image",
                    imageKey: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                    byteLength: 3,
                    mimeType: "image/png",
                },
            },
        ];
        for (const [index, payload] of updates.entries()) {
            paired.daemon.send(
                encodeDaemonToServiceMessage({
                    kind: "session.event.v2",
                    event: {
                        type: "acp",
                        eventId: `event-${index}`,
                        position: (index + 1).toString(),
                        provenance: { kind: "original" },
                        recordedAt: "2026-10-09T00:00:00Z",
                        sessionId: prompt.sessionId,
                        payload,
                    },
                }),
            );
        }
        cleanup();
        await closeMobiusTransport();
        createTestApplication();
        const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND, signal));
        await sendReadySession(paired.daemon, prepare);
        const file = decodeFileReadCommand(await paired.daemon.receive(FILE_READ_KIND, signal));
        expect(file.path).toBe("mobius-content:image:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        paired.daemon.send(
            encodeFileBeginEvent({
                kind: "file.begin",
                requestId: file.requestId,
                sessionId: file.sessionId,
                byteLength: 3,
                mediaType: "image/png",
                modifiedAt: "2026-10-09T00:00:00Z",
                name: "image.png",
            }),
        );
        paired.daemon.send(
            encodeFileChunkEvent({
                kind: "file.chunk",
                requestId: file.requestId,
                sessionId: file.sessionId,
                sequence: 0,
                data: "YWJj",
            }),
        );
        paired.daemon.send(
            encodeFileEndEvent({ kind: "file.end", requestId: file.requestId, sessionId: file.sessionId }),
        );
        await waitForDocumentState(() => screen.queryByRole("img", { name: "Agent-provided image" }) !== null, signal);
        expect(screen.getByText("The picture is ready")).toBeTruthy();
        expect(screen.getByText("Inspect workspace")).toBeTruthy();
        expect(screen.getByText(/Earlier history is not shown/)).toBeTruthy();
        expect(screen.queryByText("Previous answer 0")).toBeNull();
    } finally {
        await paired.close();
        vi.useRealTimers();
    }
});
