import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { isRecord, readAgentName, readAgentVersion } from "../../support/acp-process.ts";

function failFirstRuntimeInitialization(clientCapabilities: unknown, selectedAgentName: string): void {
    if (
        process.env["MOBIUS_FAKE_ACP_FAIL_RUNTIME_INITIALIZATION"] !== selectedAgentName ||
        !isRecord(clientCapabilities) ||
        !Reflect.has(clientCapabilities, "plan")
    ) {
        return;
    }
    if (process.env["MOBIUS_FAKE_ACP_ALWAYS_FAIL_RUNTIME_INITIALIZATION"] === "1") {
        throw new Error("Persistent fake ACP initialization failure");
    }
    const stateDirectory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
    if (stateDirectory === undefined) {
        throw new Error("Fake ACP state directory is required");
    }
    mkdirSync(stateDirectory, { recursive: true });
    const markerPath = join(
        stateDirectory,
        `${selectedAgentName.toLowerCase().replaceAll(" ", "-")}.runtime-initialization-failed`,
    );
    if (existsSync(markerPath)) {
        return;
    }
    writeFileSync(markerPath, `${process.pid.toString()}\n`, {
        flag: "wx",
        mode: 0o600,
    });
    throw new Error("Transient fake ACP initialization failure");
}

export function registerInitialization(agent: ReturnType<typeof acp.agent>) {
    const agentName = readAgentName();
    return agent.onRequest(acp.methods.agent.initialize, (context) => {
        failFirstRuntimeInitialization(context.params.clientCapabilities, agentName);
        return {
            _meta: {
                steering: { supported: !process.argv.includes("--no-steering") },
            },
            agentCapabilities: {
                _meta: {
                    claudeCode: { promptQueueing: !process.argv.includes("--no-prompt-queueing") },
                },
                loadSession: !process.argv.includes("--no-load-session"),
                ...(process.argv.includes("--http-mcp") ? { mcpCapabilities: { http: true } } : {}),
                promptCapabilities: {
                    embeddedContext: !process.argv.includes("--no-embedded-context"),
                    image: !process.argv.includes("--no-image-prompt"),
                },
                sessionCapabilities: {
                    ...(process.argv.includes("--no-additional-directories") ? {} : { additionalDirectories: {} }),
                    close: {},
                    ...(process.argv.includes("--load-only") ? {} : { resume: {} }),
                    ...(process.argv.includes("--no-native-sessions")
                        ? {}
                        : {
                              list: {},
                              ...(process.argv.includes("--no-delete-session") ? {} : { delete: {} }),
                              ...(process.argv.includes("--no-fork-session") ? {} : { fork: {} }),
                          }),
                },
            },
            authMethods: process.argv.includes("--external-authentication")
                ? [
                      {
                          description: "Use the existing local Agent login",
                          id: "external",
                          name: "External login",
                      },
                  ]
                : [],
            agentInfo: { name: "Mobius test agent", version: readAgentVersion() },
            protocolVersion: acp.PROTOCOL_VERSION,
        };
    });
}
