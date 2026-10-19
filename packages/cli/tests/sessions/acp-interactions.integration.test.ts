import { describe, expect, it } from "vitest";
import { acpAdapters } from "../../src/acp/adapter/registry.ts";
import { AgentRuntimeManager } from "../../src/acp/agent-runtime-manager.ts";
import { NullAcpSessionObserver } from "../../src/acp/session-contracts.ts";
import { MemoryAcpSessionStore } from "../../src/acp/session-store.ts";
import { systemDaemonTimer } from "../../src/daemon/relay/timer.ts";
import { AcpContentExternalizer } from "../../src/external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../../src/external-content/local-external-content-store.ts";
import { completeAcpControls, createControlledSession } from "./acp-controls-fixture.ts";

import { fakeAgent } from "./acp-feature-fixture.ts";

describe("acp interactions", () => {
    it("Given an Agent turn is running, When a targeted steering prompt is submitted, Then it is injected into that exact turn and preserves the Agent message anchor", async () => {
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const signal = new AbortController().signal;
        const activityArrived = Promise.withResolvers<void>();
        const output: { readonly messageId: string; readonly text: string }[] = [];
        try {
            const running = manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "running-command",
                cwd: process.cwd(),
                images: [],
                onActivity: () => {
                    activityArrived.resolve();
                    return Promise.resolve();
                },
                onText: (text, messageId) => {
                    output.push({ messageId, text });
                    return Promise.resolve();
                },
                prompt: "wait for steering",
                resources: [],
                sessionId: "steering-session",
                signal,
            });
            await activityArrived.promise;

            await expect(
                manager.steerPrompt({
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    commandId: "steering-command",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "focus on the requested fix",
                    resources: [],
                    sessionId: "steering-session",
                    signal,
                    targetCommandId: "running-command",
                }),
            ).resolves.toBe("injected");
            await expect(running).resolves.toMatchObject({ stopReason: "end_turn" });
            expect(output).toContainEqual({
                messageId: "assistant-1",
                text: "Steered: focus on the requested fix",
            });
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
            session.observer.eventsV2.flatMap(({ event }) =>
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
        expect(session.observer.eventsV2.map(({ position }) => position)).toEqual(
            session.observer.eventsV2.map(({ position }) => position).toSorted((left, right) => left - right),
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
            onActivity: async () => {},
            onText: async () => {},
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
