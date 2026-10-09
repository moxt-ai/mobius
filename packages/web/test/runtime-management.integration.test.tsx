import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openPairedApplication, setupWebIntegrationEnvironment } from "./app-integration-harness.ts";
import { type AgentDaemonSocket, FakeAgentDaemon } from "./support/daemon/connection.ts";

interface ClaimedRuntimePairing {
    readonly channelId: string;
    readonly daemonToken: string;
    readonly runtimeId: string;
}

interface ClaimedRuntime {
    readonly channelId: string;
    readonly daemon: FakeAgentDaemon;
    readonly runtimeId: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeClaimedRuntimePairing(value: unknown): ClaimedRuntimePairing {
    if (
        !isRecord(value) ||
        typeof value["channelId"] !== "string" ||
        typeof value["runtimeCredential"] !== "string" ||
        typeof value["runtimeId"] !== "string"
    ) {
        throw new Error("The Relay returned an invalid claimed Runtime pairing");
    }
    return {
        channelId: value["channelId"],
        daemonToken: value["runtimeCredential"],
        runtimeId: value["runtimeId"],
    };
}

async function claimRuntimePairing(pairingCode: string, pairingId: string, readyAgent = true): Promise<ClaimedRuntime> {
    const response = await fetch(
        new URL(`${MOBIUS_API_PREFIX}/v1/runtime-pairings/${pairingId}/redeem`, window.location.origin),
        {
            body: JSON.stringify({
                agents: readyAgent
                    ? [
                          {
                              agentPath: "/usr/local/bin/claude",
                              agentVersion: "claude 2.1.0",
                              capabilities: {
                                  additionalDirectories: true,
                                  audioPrompt: false,
                                  closeSession: true,
                                  deleteSession: true,
                                  embeddedContextPrompt: true,
                                  imagePrompt: true,
                                  listSessions: true,
                                  loadSession: true,
                                  promptQueueing: false,
                                  resumeSession: true,
                                  steering: false,
                                  unstableForkSession: false,
                              },
                              id: "claude-code",
                              label: "Claude Code",
                          },
                      ]
                    : [],
                installableAgents: readyAgent
                    ? []
                    : [
                          {
                              id: "codex",
                              label: "Codex",
                              status: "agent_not_installed",
                          },
                      ],
                machineName: "Second integration machine",
                pairingCode,
                workspaceName: "second-workspace",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        },
    );
    expect(response.status).toBe(200);
    const claimed = decodeClaimedRuntimePairing(await response.json());
    const daemonUrl = new URL(`${MOBIUS_API_PREFIX}/channels/${claimed.channelId}/daemon`, window.location.origin);
    daemonUrl.protocol = "ws:";
    daemonUrl.searchParams.set("token", claimed.daemonToken);
    return {
        channelId: claimed.channelId,
        daemon: await FakeAgentDaemon.connect(daemonUrl, (url) => new WebSocket(url) as unknown as AgentDaemonSocket),
        runtimeId: claimed.runtimeId,
    };
}

setupWebIntegrationEnvironment();

describe.sequential("Project Runtime management", () => {
    it("Given an owned Project with one paired Runtime, When another machine is paired and revoked from Web, Then both machines are shown independently and the current machine stays online", async ({
        signal,
    }) => {
        const paired = await openPairedApplication();
        const additionalDaemons: FakeAgentDaemon[] = [];

        try {
            await screen.findByRole("heading", { level: 1, name: "Local Agents" });
            fireEvent.click(screen.getByRole("link", { name: "Local machines" }));

            await screen.findByRole("heading", { level: 1, name: "Local machines" });
            const initialDirectory = await screen.findByRole("list", { name: "Project runtimes" });
            expect(within(initialDirectory).getAllByRole("listitem")).toHaveLength(1);
            expect(within(initialDirectory).getByText("Integration machine")).toBeTruthy();
            expect(within(initialDirectory).getByText("Online")).toBeTruthy();

            fireEvent.click(screen.getByRole("button", { name: "Pair another machine" }));
            const pairingCodeInput = await screen.findByRole("textbox", { name: "One-time pairing code" });
            const pairingCode = pairingCodeInput.getAttribute("value");
            if (pairingCode === null) {
                throw new Error("Expected the Web pairing flow to expose a pairing code");
            }
            const pairingCommand = screen.getByRole("textbox", { name: "Pairing command" });
            expect(pairingCommand.getAttribute("value")).toContain(`--code ${pairingCode}`);
            expect(pairingCommand.getAttribute("value")).not.toContain(paired.credential.hostToken);

            const pairingId = pairingCommand.getAttribute("value")?.match(/--pairing ([a-zA-Z0-9._:-]+)/)?.[1];
            if (pairingId === undefined) {
                throw new Error("Missing pairing ID in command");
            }
            const additional = await claimRuntimePairing(pairingCode, pairingId);
            const additionalDaemon = additional.daemon;
            additionalDaemons.push(additionalDaemon);
            fireEvent.click(screen.getByRole("button", { name: "Check connection" }));

            await screen.findByText("Second integration machine is connected.");
            const pairedDirectory = await screen.findByRole("list", { name: "Project runtimes" });
            expect(within(pairedDirectory).getAllByRole("listitem")).toHaveLength(2);
            const secondMachine = within(pairedDirectory).getByText("Second integration machine").closest("li");
            if (secondMachine === null) {
                throw new Error("Expected the second Runtime list item");
            }
            expect(within(secondMachine).getByText("second-workspace")).toBeTruthy();
            expect(within(secondMachine).getByText("Claude Code")).toBeTruthy();
            expect(within(secondMachine).getByText("Online")).toBeTruthy();

            fireEvent.click(within(secondMachine).getByRole("button", { name: "Revoke Second integration machine" }));
            fireEvent.click(
                within(secondMachine).getByRole("button", {
                    name: "Confirm revoke Second integration machine",
                }),
            );

            await additionalDaemon.waitForClose(signal);
            await screen.findByText("Second integration machine was revoked.");
            await waitFor(() => {
                const remainingDirectory = screen.getByRole("list", { name: "Project runtimes" });
                expect(within(remainingDirectory).getAllByRole("listitem")).toHaveLength(1);
                expect(within(remainingDirectory).getByText("Integration machine")).toBeTruthy();
                expect(within(remainingDirectory).getByText("Online")).toBeTruthy();
            });
        } finally {
            for (const daemon of additionalDaemons) {
                daemon.close();
            }
            await paired.close();
        }
    });
});
