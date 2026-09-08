import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import { LocalAgentDefinition } from "../src/config.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

describe("Grok Build session configuration", () => {
    it("Given Grok Build reports standard ACP configuration, When the user changes model and reasoning effort, Then Mobius uses the standard configuration protocol", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("grok-build", "Grok Build", process.execPath, [fakeAgentPath]);
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "standard-grok-build-config",
            signal: new AbortController().signal,
        };

        try {
            await manager.prepareSession(session);
            const withModel = await manager.configureSession({
                ...session,
                booleanValue: false,
                configId: "model",
                requestId: "standard-grok-model",
                value: "test-large",
                valueType: "select",
            });
            expect(withModel).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        category: "model",
                        currentValue: "test-large",
                    }),
                ]),
            );

            const withEffort = await manager.configureSession({
                ...session,
                booleanValue: false,
                configId: "reasoning_effort",
                requestId: "standard-grok-effort",
                value: "high",
                valueType: "select",
            });
            expect(withEffort).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        category: "thought_level",
                        currentValue: "high",
                    }),
                ]),
            );
        } finally {
            await manager.close();
        }
    });

    it("Given Grok Build reports its legacy model configuration, When a session is prepared and configured, Then Mobius exposes model and reasoning effort controls and applies both through Grok ACP", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("grok-build", "Grok Build", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Grok Build",
            "--grok-legacy-config",
            "--grok-legacy-no-selected-effort",
        ]);
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "grok-build-config",
            signal: new AbortController().signal,
        };

        try {
            const prepared = await manager.prepareSession(session);
            expect(prepared.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        category: "model",
                        currentValue: "test-small",
                        id: "grok_build_legacy_model",
                        values: expect.arrayContaining([
                            expect.objectContaining({
                                name: "Test Large",
                                value: "test-large",
                            }),
                        ]),
                    }),
                    expect.objectContaining({
                        category: "thought_level",
                        currentValue: "agent_default",
                        id: "grok_build_legacy_reasoning_effort",
                        values: expect.arrayContaining([
                            expect.objectContaining({
                                name: "Agent default",
                                value: "agent_default",
                            }),
                            expect.objectContaining({ name: "High", value: "high" }),
                        ]),
                    }),
                ]),
            );

            const withModel = await manager.configureSession({
                ...session,
                booleanValue: false,
                configId: "grok_build_legacy_model",
                requestId: "grok-model",
                value: "test-large",
                valueType: "select",
            });
            expect(withModel).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        category: "model",
                        currentValue: "test-large",
                    }),
                ]),
            );

            const withEffort = await manager.configureSession({
                ...session,
                booleanValue: false,
                configId: "grok_build_legacy_reasoning_effort",
                requestId: "grok-effort",
                value: "high",
                valueType: "select",
            });
            expect(withEffort).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        category: "thought_level",
                        currentValue: "high",
                    }),
                ]),
            );
            expect(
                withEffort
                    .find((option) => option.category === "thought_level")
                    ?.values.some((value) => value.value === "agent_default"),
            ).toBe(false);
        } finally {
            await manager.close();
        }
    });

    it("Given Grok Build returns an invalid legacy configuration response, When the user changes reasoning effort, Then Mobius reports a stable sanitized failure", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("grok-build", "Grok Build", process.execPath, [
            fakeAgentPath,
            "--grok-legacy-config",
            "--invalid-grok-config-response",
        ]);
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "invalid-grok-build-config",
            signal: new AbortController().signal,
        };

        try {
            const prepared = await manager.prepareSession(session);
            expect(
                prepared.configOptions
                    .find((option) => option.category === "thought_level")
                    ?.values.some((value) => value.value === "agent_default"),
            ).toBe(false);
            await expect(
                manager.configureSession({
                    ...session,
                    booleanValue: false,
                    configId: "grok_build_legacy_reasoning_effort",
                    requestId: "invalid-grok-effort",
                    value: "high",
                    valueType: "select",
                }),
            ).rejects.toMatchObject({
                code: "invalid_session_configuration_response",
                message: "Grok Build returned an invalid session configuration response",
            });
        } finally {
            await manager.close();
        }
    });
});
