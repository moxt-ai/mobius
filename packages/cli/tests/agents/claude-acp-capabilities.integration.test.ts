import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { type AcpClientHandler, createAcpClient } from "../../src/engine/acp/connection/create-client.ts";
import { createClaudeAcpApp } from "../../src/engine/acp/harness/claude/upstream/dist/lib.js";

const clientHandler: AcpClientHandler = {
    onElicitation: async () => {
        throw new Error("Initialization must not request elicitation");
    },
    onElicitationComplete: async () => Promise.resolve(),
    onPermission: async () => {
        throw new Error("Initialization must not request permission");
    },
    onUpdate: async () => Promise.resolve(),
};

test("Given a client advertises JetBrains Air extensions, When it initializes the Claude ACP fork, Then the agent exposes only its supported non-JetBrains capabilities", async () => {
    const claude = createClaudeAcpApp({ environment: {} });
    const connection = createAcpClient(clientHandler).connect(claude.app);
    try {
        const initialized = await connection.agent.request(methods.agent.initialize, {
            clientCapabilities: {
                _meta: {
                    jetbrains: {
                        air: {
                            capabilities: [
                                "sessionFailure",
                                "agentFileChangeReport",
                                "nativeSubagentSessions",
                                "asyncTasks",
                            ],
                            version: 1,
                        },
                    },
                },
            },
            clientInfo: { name: "mobius-contract-test", version: "1.0.0" },
            protocolVersion: PROTOCOL_VERSION,
        });

        expect(JSON.stringify(initialized)).not.toContain("jetbrains");
        if (initialized.agentCapabilities === undefined) {
            throw new Error("Claude ACP did not advertise agent capabilities");
        }
        expect(initialized.agentCapabilities.sessionCapabilities).toEqual({
            additionalDirectories: {},
            close: {},
            delete: {},
            fork: {},
            list: {},
            resume: {},
        });
    } finally {
        await claude.agent()?.dispose();
        connection.close();
    }
});
