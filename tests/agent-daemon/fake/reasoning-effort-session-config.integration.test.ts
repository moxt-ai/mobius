import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../../../packages/cli/src/acp/session-manager.ts";
import {
    agentSettingsAdapterForAgent,
    applyAgentLaunchSettings,
    DEEPSEEK_HARNESS_ACCESS_MODE_SETTING_ID,
    OPENCODE_PERMISSION_SETTING_ID,
} from "../../../packages/cli/src/agent-catalog/agent-settings-adapter.ts";
import { LocalAgentDefinition } from "../../../packages/cli/src/config.ts";

const fakeAgentPath = fileURLToPath(new URL("../fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

describe("Agent setting capabilities", () => {
    it("Given an Agent reports its reasoning effort as the provider default, When a session is prepared, Then Mobius keeps the effort setting with that current value", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("deepseek-harness", "DeepSeek Harness", process.execPath, [
            fakeAgentPath,
            "--effort-provider-default",
        ]);
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "deepseek-provider-default-effort",
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
                requestId: "provider-default-to-high",
                value: "high",
                valueType: "select",
            });
            expect(configured).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ currentValue: "high", id: "reasoning_effort", type: "select" }),
                ]),
            );
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent does not expose adjustable reasoning effort, When a session is prepared, Then Mobius does not invent an effort setting", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("deepseek-harness", "DeepSeek Harness", process.execPath, [
            fakeAgentPath,
            "--without-reasoning-effort",
        ]);
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "deepseek-without-effort",
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
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("pi", "Pi", process.execPath, [
            fakeAgentPath,
            "--without-model",
            "--without-reasoning-effort",
        ]);

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
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("fake", "Fake", process.execPath, [
            fakeAgentPath,
            "--ignore-config-update",
        ]);
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
                    requestId: "ignored-model-update",
                    value: "test-large",
                    valueType: "select",
                }),
            ).rejects.toMatchObject({ code: "invalid_session_configuration" });
        } finally {
            await manager.close();
        }
    });

    it("Given DeepSeek Harness and OpenCode expose adapter-owned launch settings, When a Turn selects one, Then only that Agent receives its supported local policy", () => {
        const deepSeek = new LocalAgentDefinition("deepseek-harness", "DeepSeek Harness", process.execPath, [
            fakeAgentPath,
        ]);
        const openCode = new LocalAgentDefinition("opencode", "OpenCode", process.execPath, [fakeAgentPath], {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "mobius-test" }),
        });

        const deepSeekSetting = agentSettingsAdapterForAgent(deepSeek.id).settings(deepSeek);
        expect(deepSeekSetting).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: DEEPSEEK_HARNESS_ACCESS_MODE_SETTING_ID })]),
        );
        const deepSeekApplied = applyAgentLaunchSettings(deepSeek, [
            {
                booleanValue: false,
                configId: DEEPSEEK_HARNESS_ACCESS_MODE_SETTING_ID,
                value: "read-only",
                valueType: "select",
            },
        ]);
        expect(deepSeekApplied.agent.environment["DSH_PERMISSION_MODE"]).toBe("read-only");
        expect(deepSeekApplied.sessionConfigurations).toEqual([]);

        const openCodeSetting = agentSettingsAdapterForAgent(openCode.id).settings(openCode);
        expect(openCodeSetting).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: OPENCODE_PERMISSION_SETTING_ID })]),
        );
        const openCodeApplied = applyAgentLaunchSettings(openCode, [
            {
                booleanValue: false,
                configId: OPENCODE_PERMISSION_SETTING_ID,
                value: "read-only",
                valueType: "select",
            },
        ]);
        expect(JSON.parse(openCodeApplied.agent.environment["OPENCODE_CONFIG_CONTENT"] ?? "{}")).toMatchObject({
            permission: {
                "*": "deny",
                glob: "allow",
                grep: "allow",
                lsp: "allow",
                read: "allow",
                skill: "allow",
            },
            theme: "mobius-test",
        });
        const pi = new LocalAgentDefinition("pi", "Pi", process.execPath, [fakeAgentPath]);
        expect(agentSettingsAdapterForAgent(pi.id).settings(pi)).toEqual([]);
    });
});
