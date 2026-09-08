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
});
