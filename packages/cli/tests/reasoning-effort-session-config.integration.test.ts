import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import { LocalAgentDefinition } from "../src/config.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

describe("required reasoning effort configuration", () => {
    it("Given an Agent does not expose adjustable reasoning effort, When a session is prepared, Then Mobius keeps the required setting visible as an unavailable Agent default", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("cursor-cli", "Cursor CLI", process.execPath, [
            fakeAgentPath,
            "--without-reasoning-effort",
        ]);
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "required-reasoning-effort",
            signal: new AbortController().signal,
        };

        try {
            const prepared = await manager.prepareSession(session);
            expect(prepared.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        category: "thought_level",
                        currentValue: "agent_default",
                        description: "This Agent does not expose adjustable reasoning effort for the selected model.",
                        id: "reasoning_effort",
                        name: "Reasoning effort",
                        type: "select",
                        values: [
                            expect.objectContaining({
                                name: "Agent default",
                                value: "agent_default",
                            }),
                        ],
                    }),
                ]),
            );

            await expect(
                manager.configureSession({
                    ...session,
                    booleanValue: false,
                    configId: "reasoning_effort",
                    requestId: "unavailable-effort",
                    value: "agent_default",
                    valueType: "select",
                }),
            ).rejects.toMatchObject({
                code: "invalid_session_configuration",
                message: "The requested ACP configuration option is unavailable",
            });
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent omits model and permission configuration, When a session is prepared, Then Mobius still exposes all required execution settings", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("pi", "Pi", process.execPath, [
            fakeAgentPath,
            "--without-model",
            "--without-reasoning-effort",
            "--with-permission-option",
        ]);
        const session = {
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "required-agent-execution-settings",
            signal: new AbortController().signal,
        };

        try {
            const prepared = await manager.prepareSession(session);
            expect(prepared.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        category: "_mobius_permission",
                        currentValue: "danger-full-access",
                        id: "permission_mode",
                        name: "Permissions",
                        values: [
                            expect.objectContaining({
                                name: "Full access (Pi default)",
                                value: "danger-full-access",
                            }),
                        ],
                    }),
                    expect.objectContaining({
                        category: "model",
                        currentValue: "agent_default",
                        id: "model",
                        name: "Model",
                    }),
                    expect.objectContaining({
                        category: "thought_level",
                        currentValue: "agent_default",
                        id: "reasoning_effort",
                        name: "Reasoning effort",
                    }),
                ]),
            );
            await expect(
                manager.configureSession({
                    ...session,
                    booleanValue: false,
                    configId: "permission_mode",
                    requestId: "reject-false-pi-sandbox",
                    value: "agent_default",
                    valueType: "select",
                }),
            ).rejects.toMatchObject({ code: "invalid_session_configuration" });
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent fills the configuration limit with its model last, When required settings are added, Then Mobius retains the authoritative model", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("pi", "Pi", process.execPath, [
            fakeAgentPath,
            "--model-last-at-option-limit",
        ]);

        try {
            const prepared = await manager.prepareSession({
                additionalDirectories: [],
                agent,
                cwd: process.cwd(),
                sessionId: "required-settings-at-option-limit",
                signal: new AbortController().signal,
            });
            expect(prepared.configOptions).toHaveLength(100);
            expect(prepared.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: "permission_mode" }),
                    expect.objectContaining({
                        currentValue: "test-small",
                        id: "model",
                        values: expect.arrayContaining([expect.objectContaining({ value: "test-large" })]),
                    }),
                    expect.objectContaining({ id: "reasoning_effort" }),
                ]),
            );
        } finally {
            await manager.close();
        }
    });

    it("Given DeepSeek Harness and OpenCode expose Mobius permission profiles, When a user changes the required setting, Then the native launch policy changes with the prepared session", async () => {
        const manager = new AcpSessionManager();
        const agents = [
            new LocalAgentDefinition("deepseek-harness", "DeepSeek Harness", process.execPath, [fakeAgentPath]),
            new LocalAgentDefinition("opencode", "OpenCode", process.execPath, [fakeAgentPath], {
                OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: "mobius-test" }),
            }),
        ];

        try {
            for (const agent of agents) {
                const session = {
                    additionalDirectories: [],
                    agent,
                    cwd: process.cwd(),
                    sessionId: `required-permission-${agent.id}`,
                    signal: new AbortController().signal,
                };
                const prepared = await manager.prepareSession(session);
                expect(prepared.configOptions).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            currentValue: agent.id === "deepseek-harness" ? "workspace-write" : "agent_default",
                            id: "permission_mode",
                            values: expect.arrayContaining([
                                expect.objectContaining({ value: "agent_default" }),
                                expect.objectContaining({ value: "read-only" }),
                                expect.objectContaining({ value: "workspace-write" }),
                                expect.objectContaining({ value: "danger-full-access" }),
                            ]),
                        }),
                    ]),
                );

                const configured = await manager.configureSession({
                    ...session,
                    booleanValue: false,
                    configId: "permission_mode",
                    requestId: `configure-permission-${agent.id}`,
                    value: "read-only",
                    valueType: "select",
                });
                expect(configured).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ currentValue: "read-only", id: "permission_mode" }),
                    ]),
                );

                const launch = agent.withPermissionMode("read-only");
                if (agent.id === "deepseek-harness") {
                    expect(launch.environment["DSH_PERMISSION_MODE"]).toBe("read-only");
                } else {
                    expect(JSON.parse(launch.environment["OPENCODE_CONFIG_CONTENT"] ?? "{}")).toMatchObject({
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
                }
            }
        } finally {
            await manager.close();
        }
    });
});
