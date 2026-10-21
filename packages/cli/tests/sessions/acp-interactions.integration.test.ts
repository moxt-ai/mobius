import { describe, expect, it } from "vitest";
import { acpAdapters } from "../../src/acp/adapter/registry.ts";
import { AgentRuntimeManager } from "../../src/acp/agent-runtime-manager.ts";
import { AcpContentExternalizer } from "../../src/acp/external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../../src/acp/external-content/local-external-content-store.ts";
import { MemoryAcpSessionStore } from "../../src/acp/session-store.ts";
import { systemTimer } from "../../src/runtime/relay/timer.ts";
import { completeAcpControls, createControlledSession } from "./acp-controls-fixture.ts";

import { fakeAgent, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp interactions", () => {
    it("Given an Agent turn is running, When a targeted steering prompt is submitted, Then it is injected into that exact turn and preserves the Agent message anchor", async () => {
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager({
            observer,
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemTimer,
            maxProcesses: null,
        });
        const signal = new AbortController().signal;
        try {
            const running = manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "running-command",
                cwd: process.cwd(),
                images: [],
                lifecycle: {
                    attemptId: "steering-attempt",
                    content: [{ text: "wait for steering", type: "text" }],
                    epoch: "steering-epoch",
                },
                prompt: "wait for steering",
                resources: [],
                sessionId: "steering-session",
                signal,
            });
            const finishedBeforeStart = running.then(() => {
                throw new Error("The steering target completed before its structured content arrived");
            });
            await Promise.race([
                observer.waitForEvent(
                    (event) =>
                        event.type === "acp" &&
                        (event.payload.sessionUpdate === "agent_message_chunk" ||
                            event.payload.sessionUpdate === "user_message_chunk" ||
                            event.payload.sessionUpdate === "agent_thought_chunk") &&
                        event.payload.content.type !== "text",
                ),
                finishedBeforeStart,
            ]);

            await expect(
                manager.steerPrompt({
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    commandId: "steering-command",
                    cwd: process.cwd(),
                    images: [],
                    lifecycle: {
                        attemptId: "steering-attempt-2",
                        content: [{ text: "focus on the requested fix", type: "text" }],
                        epoch: "steering-epoch-2",
                    },
                    prompt: "focus on the requested fix",
                    resources: [],
                    sessionId: "steering-session",
                    signal,
                    targetCommandId: "running-command",
                }),
            ).resolves.toBe("injected");
            await expect(running).resolves.toMatchObject({ stopReason: "end_turn" });
            expect(observer.agentText()).toContain("Steered: focus on the requested fix");
        } finally {
            await manager.close();
        }
    });

    it("Given ACP requests permission followed by a form, When the user allows and submits a branch, Then both interactions remain correlated and the prompt consumes the response", async () => {
        await using session = await createControlledSession();
        const result = await completeAcpControls(session);
        expect(result.permission).toMatchObject({
            commandId: "controls-command",
            title: "Run the verification command",
        });
        expect(result.elicitation).toMatchObject({
            fields: [expect.objectContaining({ name: "branch", required: true })],
            mode: "form",
        });
        expect(result.completed).toEqual({ stopReason: "end_turn" });
        expect(result.text).toContain("main");
        expect(
            session.observer.events.flatMap(({ event }) =>
                event.type === "lifecycle-metadata" ? [event.payload.kind] : [],
            ),
        ).toEqual([
            "prompt.requested",
            "prompt.started",
            "session.permission.requested",
            "session.permission.resolved",
            "session.elicitation.requested",
            "session.elicitation.resolved",
            "prompt.completed",
        ]);
        expect(session.observer.events.map(({ position }) => position)).toEqual(
            session.observer.events.map(({ position }) => position).toSorted((left, right) => left - right),
        );
    });

    it("Given URL elicitation, When the user consents and the agent reports completion, Then the out-of-band interaction stays correlated through completion", async () => {
        await using session = await createControlledSession();
        const running = session.manager.runPrompt({
            ...session.request,
            commandId: "url-command",
            prompt: "exercise URL elicitation",
            images: [],
            resources: [],
        });
        const elicitation = await Promise.race([
            session.observer.elicitationArrived.promise,
            running.then(() => {
                throw new Error("The prompt completed before URL elicitation");
            }),
        ]);
        expect(elicitation).toMatchObject({
            accepted: false,
            mode: "url",
            url: expect.stringContaining("https://example.com/connect/"),
        });
        await session.manager.respondElicitation({
            action: "accept",
            content: "",
            interactionId: elicitation.interactionId,
            sessionId: session.request.sessionId,
        });
        await expect(running).resolves.toEqual({ stopReason: "end_turn" });
        expect(session.observer.elicitationResolutions.map((event) => event.action)).toEqual(["accept", "complete"]);
    });
});
