import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { NullSessionObserver } from "../../src/engine/session/api/session-api.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";

import { createControlledSession } from "./acp-controls-fixture.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

describe("Agent setting capabilities", () => {
    it("Given an Agent reports its reasoning effort as the provider default, When a session is prepared, Then Mobius keeps the effort setting with that current value", async () => {
        const manager = new SessionManager({
            observer: new NullSessionObserver(),
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer((sessionId, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    sessionId,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        const agent = new AcpAgentDefinition(
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
            (options) =>
                new ControlledAcpConnection(
                    {
                        id: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--effort-provider-default"],
                        environment: options.environment,
                    },
                    options,
                ),
        );
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "controlled-provider-default-effort",
            signal: new AbortController().signal,
        };

        try {
            const prepared = await manager.prepareSession(session);
            expect(prepared.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        currentValue: "",
                        id: "reasoning_effort",
                        type: "select",
                        values: expect.arrayContaining([expect.objectContaining({ value: "" })]),
                    }),
                ]),
            );
            const effort = prepared.configOptions.find((option) => option.id === "reasoning_effort");
            expect(effort?.type === "select" ? effort.values.map((value) => value.value) : []).toEqual([
                "",
                "low",
                "medium",
                "high",
            ]);
            const configured = await manager.configureSession({
                ...session,
                booleanValue: false,
                configId: "reasoning_effort",
                expectedConfigurationRevision: null,
                requestId: "provider-default-to-high",
                value: "high",
                valueType: "select",
            });
            expect(configured.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ currentValue: "high", id: "reasoning_effort", type: "select" }),
                ]),
            );
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent does not expose adjustable reasoning effort, When a session is prepared, Then Mobius does not invent an effort setting", async () => {
        const manager = new SessionManager({
            observer: new NullSessionObserver(),
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer((sessionId, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    sessionId,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        const agent = new AcpAgentDefinition(
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
            (options) =>
                new ControlledAcpConnection(
                    {
                        id: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--without-reasoning-effort"],
                        environment: options.environment,
                    },
                    options,
                ),
        );
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "controlled-without-effort",
            signal: new AbortController().signal,
        };

        try {
            const prepared = await manager.prepareSession(session);
            expect(prepared.configOptions).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ id: "reasoning_effort" })]),
            );
            await expect(
                manager.configureSession({
                    ...session,
                    booleanValue: false,
                    configId: "reasoning_effort",
                    expectedConfigurationRevision: null,
                    requestId: "unavailable-effort",
                    value: "high",
                    valueType: "select",
                }),
            ).rejects.toMatchObject({ code: "invalid_session_configuration" });
        } finally {
            await manager.close();
        }
    });

    it("Given Pi exposes no approval or sandbox setting, When its session is prepared, Then Mobius exposes no synthetic execution control", async () => {
        const manager = new SessionManager({
            observer: new NullSessionObserver(),
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer((sessionId, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    sessionId,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        const agent = new AcpAgentDefinition(
            "pi",
            "Pi",
            process.execPath,
            (options) =>
                new ControlledAcpConnection(
                    {
                        id: "pi",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--without-model", "--without-reasoning-effort"],
                        environment: options.environment,
                    },
                    options,
                ),
        );

        try {
            const prepared = await manager.prepareSession({
                additionalDirectories: [],
                agent,
                cwd: process.cwd(),
                sessionId: "pi-native-settings-only",
                signal: new AbortController().signal,
            });
            expect(prepared.configOptions).not.toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: "model" }),
                    expect.objectContaining({ id: "permission_mode" }),
                    expect.objectContaining({ id: "reasoning_effort" }),
                ]),
            );
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent acknowledges a setting without applying it, When Mobius configures the session, Then the Turn is rejected", async () => {
        const manager = new SessionManager({
            observer: new NullSessionObserver(),
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer((sessionId, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    sessionId,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        const agent = new AcpAgentDefinition(
            "fake",
            "Fake",
            process.execPath,
            (options) =>
                new ControlledAcpConnection(
                    {
                        id: "fake",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--ignore-config-update"],
                        environment: options.environment,
                    },
                    options,
                ),
        );
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "ignored-setting-update",
            signal: new AbortController().signal,
        };

        try {
            await manager.prepareSession(session);
            await expect(
                manager.configureSession({
                    ...session,
                    booleanValue: false,
                    configId: "model",
                    expectedConfigurationRevision: null,
                    requestId: "ignored-model-update",
                    value: "test-large",
                    valueType: "select",
                }),
            ).rejects.toMatchObject({ code: "invalid_session_configuration" });
        } finally {
            await manager.close();
        }
    });
});

it("Given ACP exposes select and boolean settings, When a user configures the conversation, Then the next prompt executes with those values", async () => {
    await using session = await createControlledSession();
    const prepared = await session.manager.prepareSession(session.request);
    expect(prepared).toMatchObject({
        agentName: "Mobius test agent",
        capabilities: {
            additionalDirectories: true,
            embeddedContextPrompt: true,
            imagePrompt: true,
            loadSession: true,
            promptQueueing: true,
            resumeSession: true,
            steering: true,
        },
        restored: false,
    });
    expect(prepared.configOptions).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ category: "mode", id: "mode" }),
            expect.objectContaining({ category: "model", id: "model" }),
            expect.objectContaining({
                category: "thought_level",
                id: "reasoning_effort",
            }),
            expect.objectContaining({ id: "fast_mode", type: "boolean" }),
        ]),
    );

    for (const [configId, value] of [
        ["model", "test-large"],
        ["mode", "plan"],
        ["reasoning_effort", "high"],
    ] as const) {
        const configured = await session.manager.configureSession({
            ...session.request,
            configId,
            expectedConfigurationRevision: null,
            value,
            booleanValue: false,
            valueType: "select",
            requestId: `configure-${configId}`,
        });
        expect(configured.configOptions).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: configId, currentValue: value })]),
        );
    }
    await session.manager.configureSession({
        ...session.request,
        configId: "fast_mode",
        expectedConfigurationRevision: null,
        value: "",
        booleanValue: true,
        valueType: "boolean",
        requestId: "configure-fast-mode",
    });

    await expect(
        session.manager.runPrompt({
            ...session.request,
            commandId: "configured-command",
            prompt: "Report execution settings",
            images: [],
            resources: [],
        }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(session.observer.agentText()).toBe("plan test-large high fast");
});
