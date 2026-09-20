import { decodeSessionPrepareCommand, MOBIUS_API_PREFIX, SESSION_PREPARE_KIND } from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    completeRenderedPrompt,
    createTestApplication,
    pairDaemon,
    StatefulDaemon,
    saveBrowserCredential,
    sendReadySession,
    setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

interface ClaimedRuntimePairing {
    readonly channelId: string;
    readonly daemonToken: string;
    readonly runtimeId: string;
}

interface ClaimedRuntime {
    readonly channelId: string;
    readonly daemon: StatefulDaemon;
    readonly runtimeId: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeClaimedRuntimePairing(value: unknown): ClaimedRuntimePairing {
    if (
        !isRecord(value) ||
        typeof value["channelId"] !== "string" ||
        typeof value["daemonToken"] !== "string" ||
        typeof value["runtimeId"] !== "string"
    ) {
        throw new Error("The Relay returned an invalid claimed Runtime pairing");
    }
    return {
        channelId: value["channelId"],
        daemonToken: value["daemonToken"],
        runtimeId: value["runtimeId"],
    };
}

async function claimRuntimePairing(pairingCode: string, readyAgent = true): Promise<ClaimedRuntime> {
    const response = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings/claim`, window.location.origin), {
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
    });
    expect(response.status).toBe(200);
    const claimed = decodeClaimedRuntimePairing(await response.json());
    const daemonUrl = new URL(`${MOBIUS_API_PREFIX}/channels/${claimed.channelId}/daemon`, window.location.origin);
    daemonUrl.protocol = "ws:";
    daemonUrl.searchParams.set("token", claimed.daemonToken);
    return {
        channelId: claimed.channelId,
        daemon: await StatefulDaemon.connect(daemonUrl),
        runtimeId: claimed.runtimeId,
    };
}

setupWebIntegrationEnvironment();

describe.sequential("Project Runtime management", () => {
    it("Given an owned Project with two paired machines, When the user starts a chat on the second machine, Then its Agent responds in a Project Runtime route", async () => {
        const paired = await pairDaemon();
        const settingsPath = `/channels/${encodeURIComponent(paired.channelId)}/settings`;
        window.history.replaceState(null, "", settingsPath);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();
        const additionalDaemons: StatefulDaemon[] = [];

        try {
            await screen.findByRole("heading", { level: 1, name: "Agent settings" });
            fireEvent.click(screen.getByRole("link", { name: "Local machines" }));
            await screen.findByRole("heading", { level: 1, name: "Local machines" });

            fireEvent.click(await screen.findByRole("button", { name: "Pair another machine" }));
            const pairingCode = (await screen.findByRole("textbox", { name: "One-time pairing code" })).getAttribute(
                "value",
            );
            if (pairingCode === null) {
                throw new Error("Expected the Web pairing flow to expose a pairing code");
            }
            const claimed = await claimRuntimePairing(pairingCode);
            additionalDaemons.push(claimed.daemon);
            fireEvent.click(screen.getByRole("button", { name: "Check connection" }));

            await screen.findByText("Second integration machine is connected.");
            const directory = await screen.findByRole("list", { name: "Project runtimes" });
            const secondMachine = within(directory).getByText("Second integration machine").closest("li");
            if (secondMachine === null) {
                throw new Error("Expected the second Runtime list item");
            }
            fireEvent.click(
                within(secondMachine).getByRole("button", { name: "Open chat on Second integration machine" }),
            );

            await waitFor(() => {
                expect(window.location.pathname).toMatch(
                    new RegExp(
                        `^/projects/${paired.credential.projectId}/runtimes/${claimed.runtimeId}/sessions/[a-zA-Z0-9._:-]+$`,
                        "u",
                    ),
                );
            });
            const preparation = decodeSessionPrepareCommand(await claimed.daemon.receive(SESSION_PREPARE_KIND));
            expect(preparation.agentId).toBe("claude-code");
            await sendReadySession(claimed.daemon, preparation);
            await completeRenderedPrompt(
                claimed.daemon,
                "Which machine are you running on?",
                "I am running on the second integration machine.",
            );
        } finally {
            cleanup();
            await closeMobiusTransport();
            for (const daemon of additionalDaemons) {
                daemon.close();
            }
            paired.daemon.close();
        }
    });

    it("Given the owner is already in a Project Runtime, When the browser reloads that URL without navigation state, Then device access still opens the owning channel", async () => {
        const paired = await pairDaemon();
        const settingsPath = `/channels/${encodeURIComponent(paired.channelId)}/settings`;
        window.history.replaceState(null, "", settingsPath);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();
        const additionalDaemons: StatefulDaemon[] = [];

        try {
            await screen.findByRole("heading", { level: 1, name: "Agent settings" });
            fireEvent.click(screen.getByRole("link", { name: "Local machines" }));
            await screen.findByRole("heading", { level: 1, name: "Local machines" });

            fireEvent.click(await screen.findByRole("button", { name: "Pair another machine" }));
            const pairingCode = (await screen.findByRole("textbox", { name: "One-time pairing code" })).getAttribute(
                "value",
            );
            if (pairingCode === null) {
                throw new Error("Expected the Web pairing flow to expose a pairing code");
            }
            const claimed = await claimRuntimePairing(pairingCode);
            additionalDaemons.push(claimed.daemon);
            fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
            await screen.findByText("Second integration machine is connected.");

            const directory = await screen.findByRole("list", { name: "Project runtimes" });
            const secondMachine = within(directory).getByText("Second integration machine").closest("li");
            if (secondMachine === null) {
                throw new Error("Expected the second Runtime list item");
            }
            fireEvent.click(
                within(secondMachine).getByRole("button", { name: "Open chat on Second integration machine" }),
            );
            await waitFor(() => {
                expect(window.location.pathname).toMatch(
                    new RegExp(
                        `^/projects/${paired.credential.projectId}/runtimes/${claimed.runtimeId}/sessions/[a-zA-Z0-9._:-]+$`,
                        "u",
                    ),
                );
            });
            const preparation = decodeSessionPrepareCommand(await claimed.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(claimed.daemon, preparation);

            // A reload drops `location.state` while keeping the credential store and the URL.
            cleanup();
            await closeMobiusTransport();
            const runtimePath = `/projects/${paired.credential.projectId}/runtimes/${claimed.runtimeId}`;
            window.history.replaceState(null, "", runtimePath);
            createTestApplication();

            await screen.findByRole("combobox", { name: "Message the local agent" });
            fireEvent.click(screen.getByRole("link", { name: "Access from other devices" }));

            await screen.findByRole("heading", { level: 1, name: "Access from other devices" });
            expect(screen.queryByText("Channel unavailable")).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            for (const daemon of additionalDaemons) {
                daemon.close();
            }
            paired.daemon.close();
        }
    });

    it("Given another paired machine has no ready Agent, When the owner opens it, Then Web enters that Runtime and shows Agent setup", async () => {
        const paired = await pairDaemon();
        const settingsPath = `/channels/${encodeURIComponent(paired.channelId)}/settings`;
        window.history.replaceState(null, "", settingsPath);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();
        const additionalDaemons: StatefulDaemon[] = [];

        try {
            await screen.findByRole("heading", { level: 1, name: "Agent settings" });
            fireEvent.click(screen.getByRole("link", { name: "Local machines" }));
            await screen.findByRole("heading", { level: 1, name: "Local machines" });

            fireEvent.click(await screen.findByRole("button", { name: "Pair another machine" }));
            const pairingCode = (await screen.findByRole("textbox", { name: "One-time pairing code" })).getAttribute(
                "value",
            );
            if (pairingCode === null) {
                throw new Error("Expected the Web pairing flow to expose a pairing code");
            }
            const claimed = await claimRuntimePairing(pairingCode, false);
            additionalDaemons.push(claimed.daemon);
            fireEvent.click(screen.getByRole("button", { name: "Check connection" }));

            await screen.findByText("Second integration machine is connected.");
            const directory = await screen.findByRole("list", { name: "Project runtimes" });
            const secondMachine = within(directory).getByText("Second integration machine").closest("li");
            if (secondMachine === null) {
                throw new Error("Expected the second Runtime list item");
            }
            fireEvent.click(
                within(secondMachine).getByRole("button", { name: "Set up an Agent on Second integration machine" }),
            );

            await screen.findByRole("heading", { level: 1, name: "Local Agents" });
            expect(screen.getByText("Not installed")).toBeTruthy();
            expect(screen.queryByRole("button", { name: "Install integration" })).toBeNull();
            expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
            expect(window.location.pathname).toBe(
                `/projects/${paired.credential.projectId}/runtimes/${claimed.runtimeId}`,
            );
        } finally {
            cleanup();
            await closeMobiusTransport();
            for (const daemon of additionalDaemons) {
                daemon.close();
            }
            paired.daemon.close();
        }
    });

    it("Given an owned Project with one paired Runtime, When another machine is paired and revoked from Web, Then both machines are shown independently and the current machine stays online", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        const settingsPath = `/channels/${encodeURIComponent(paired.channelId)}/settings`;
        window.history.replaceState(null, "", settingsPath);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();
        const additionalDaemons: StatefulDaemon[] = [];

        try {
            await screen.findByRole("heading", { level: 1, name: "Agent settings" });
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

            const additional = await claimRuntimePairing(pairingCode);
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
            cleanup();
            await closeMobiusTransport();
            for (const daemon of additionalDaemons) {
                daemon.close();
            }
            paired.daemon.close();
        }
    });

    it("Given a browser linked by one-time access, When it opens Local machines, Then it can see Runtimes without owner pairing or revocation controls", async () => {
        const paired = await pairDaemon();
        const accessPath = `/channels/${encodeURIComponent(paired.channelId)}/access`;
        window.history.replaceState(null, "", accessPath);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

        try {
            await screen.findByRole("heading", { level: 1, name: "Access from other devices" });
            fireEvent.click(await screen.findByRole("button", { name: "Create one-time access link" }));
            const accessLink = (
                await screen.findByRole("textbox", {
                    name: "One-time access link",
                })
            ).getAttribute("value");
            if (accessLink === null) {
                throw new Error("Expected a one-time linked-browser access URL");
            }

            cleanup();
            await closeMobiusTransport();
            window.localStorage.clear();
            window.history.replaceState(null, "", accessLink);
            createTestApplication();

            const linkedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, linkedPreparation);
            await screen.findByRole("combobox", { name: "Message the local agent" });
            fireEvent.click(screen.getByRole("link", { name: "Local machines" }));

            await screen.findByRole("heading", { level: 1, name: "Local machines" });
            expect(
                await screen.findByText(
                    "This browser has linked-device access. It can open a chat on any online Project Runtime, but only the original owner browser can pair or revoke local machines.",
                ),
            ).toBeTruthy();
            const directory = await screen.findByRole("list", { name: "Project runtimes" });
            expect(within(directory).getByText("Integration machine")).toBeTruthy();
            expect(screen.queryByRole("button", { name: "Pair another machine" })).toBeNull();
            expect(within(directory).queryByRole("button", { name: /Revoke/ })).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a browser linked by one-time access, When it opens another paired machine, Then that machine's Agent responds", async () => {
        const paired = await pairDaemon();
        const settingsPath = `/channels/${encodeURIComponent(paired.channelId)}/settings`;
        window.history.replaceState(null, "", settingsPath);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();
        const additionalDaemons: StatefulDaemon[] = [];

        try {
            await screen.findByRole("heading", { level: 1, name: "Agent settings" });
            fireEvent.click(screen.getByRole("link", { name: "Local machines" }));
            await screen.findByRole("heading", { level: 1, name: "Local machines" });

            fireEvent.click(await screen.findByRole("button", { name: "Pair another machine" }));
            const pairingCode = (await screen.findByRole("textbox", { name: "One-time pairing code" })).getAttribute(
                "value",
            );
            if (pairingCode === null) {
                throw new Error("Expected the Web pairing flow to expose a pairing code");
            }
            const claimed = await claimRuntimePairing(pairingCode);
            additionalDaemons.push(claimed.daemon);
            fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
            await screen.findByText("Second integration machine is connected.");

            fireEvent.click(screen.getByRole("link", { name: "Access from other devices" }));
            fireEvent.click(await screen.findByRole("button", { name: "Create one-time access link" }));
            const accessLink = (
                await screen.findByRole("textbox", {
                    name: "One-time access link",
                })
            ).getAttribute("value");
            if (accessLink === null) {
                throw new Error("Expected a one-time linked-browser access URL");
            }

            cleanup();
            await closeMobiusTransport();
            window.localStorage.clear();
            window.history.replaceState(null, "", accessLink);
            createTestApplication();

            const linkedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, linkedPreparation);
            await screen.findByRole("combobox", { name: "Message the local agent" });
            fireEvent.click(screen.getByRole("link", { name: "Local machines" }));

            const directory = await screen.findByRole("list", { name: "Project runtimes" });
            const secondMachine = within(directory).getByText("Second integration machine").closest("li");
            if (secondMachine === null) {
                throw new Error("Expected the second Runtime list item");
            }
            fireEvent.click(
                within(secondMachine).getByRole("button", { name: "Open chat on Second integration machine" }),
            );

            await waitFor(() => {
                expect(window.location.pathname).toMatch(
                    new RegExp(
                        `^/projects/${paired.credential.projectId}/runtimes/${claimed.runtimeId}/sessions/[a-zA-Z0-9._:-]+$`,
                        "u",
                    ),
                );
            });
            const preparation = decodeSessionPrepareCommand(await claimed.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(claimed.daemon, preparation);
            await completeRenderedPrompt(
                claimed.daemon,
                "Which machine are you running on?",
                "I am running on the second integration machine.",
            );
        } finally {
            cleanup();
            await closeMobiusTransport();
            for (const daemon of additionalDaemons) {
                daemon.close();
            }
            paired.daemon.close();
        }
    });
});
