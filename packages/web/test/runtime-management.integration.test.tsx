import { decodeSessionPrepareCommand, MOBIUS_API_PREFIX, SESSION_PREPARE_KIND } from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "@/app";
import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    pairDaemon,
    StatefulDaemon,
    saveBrowserCredential,
    sendReadySession,
    setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

interface ClaimedRuntimePairing {
    readonly channelId: string;
    readonly daemonToken: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeClaimedRuntimePairing(value: unknown): ClaimedRuntimePairing {
    if (!isRecord(value) || typeof value["channelId"] !== "string" || typeof value["daemonToken"] !== "string") {
        throw new Error("The Relay returned an invalid claimed Runtime pairing");
    }
    return {
        channelId: value["channelId"],
        daemonToken: value["daemonToken"],
    };
}

async function claimRuntimePairing(pairingCode: string): Promise<StatefulDaemon> {
    const response = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings/claim`, window.location.origin), {
        body: JSON.stringify({
            agents: [
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
                        resumeSession: true,
                        unstableForkSession: false,
                    },
                    id: "claude-code",
                    label: "Claude Code",
                },
            ],
            installableAgents: [],
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
    return await StatefulDaemon.connect(daemonUrl);
}

setupWebIntegrationEnvironment();

describe.sequential("Project Runtime management", () => {
    it("Given an owned Project with one paired Runtime, When another machine is paired and revoked from Web, Then both machines are shown independently and the current machine stays online", async () => {
        const paired = await pairDaemon();
        const settingsPath = `/channels/${encodeURIComponent(paired.channelId)}/settings`;
        window.history.replaceState(null, "", settingsPath);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);
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

            const additionalDaemon = await claimRuntimePairing(pairingCode);
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

            await additionalDaemon.waitForClose();
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
        render(<App />);

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
            render(<App />);

            const linkedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, linkedPreparation);
            await screen.findByRole("textbox", { name: "Message the local agent" });
            fireEvent.click(screen.getByRole("link", { name: "Local machines" }));

            await screen.findByRole("heading", { level: 1, name: "Local machines" });
            expect(
                await screen.findByText(
                    "This browser has linked-device access. It can see Project Runtimes, but only the original owner browser can pair or revoke local machines.",
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
});
