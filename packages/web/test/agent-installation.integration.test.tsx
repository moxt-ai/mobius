import {
    AGENT_INSTALL_PROGRESS_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    decodeAgentInstallRequestCommand,
    encodeAgentInstallFailedEvent,
    encodeAgentInstallProgressEvent,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "@/app";
import { AgentIntegrationOption } from "@/domain/channel";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { pairDaemon, saveBrowserCredential, setupWebIntegrationEnvironment } from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Agent integration installation", () => {
    it("Given a paired machine has not detected multiple local Agents, When the Web user checks again, Then Web rechecks every Agent and keeps integration setup automatic", async () => {
        const paired = await pairDaemon({
            agents: [],
            installableAgents: [
                { id: "codex", label: "Codex", status: "agent_not_installed" },
                { id: "pi", label: "Pi", status: "agent_not_installed" },
            ],
        });
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            await screen.findByRole("heading", {
                level: 1,
                name: "Local Agents",
            });
            expect(await screen.findAllByText("Not installed")).toHaveLength(2);
            expect(screen.queryByRole("button", { name: "Install integration" })).toBeNull();

            const checkAgain = screen.getByRole("button", { name: "Check again" });
            await waitFor(() => {
                expect(checkAgain.hasAttribute("disabled")).toBe(false);
            });
            fireEvent.click(checkAgain);
            const requests = [
                decodeAgentInstallRequestCommand(await paired.daemon.receive(AGENT_INSTALL_REQUEST_KIND)),
                decodeAgentInstallRequestCommand(await paired.daemon.receive(AGENT_INSTALL_REQUEST_KIND)),
            ];
            expect(requests.map((request) => request.agentId).sort()).toEqual(["codex", "pi"]);
            expect(await screen.findAllByText("Checking")).toHaveLength(2);
            expect(screen.getByRole("button", { name: "Checking local Agents…" }).hasAttribute("disabled")).toBe(true);

            for (const request of requests) {
                if (request.agentId === "codex") {
                    paired.daemon.send(
                        encodeAgentInstallProgressEvent({
                            agentId: request.agentId,
                            kind: AGENT_INSTALL_PROGRESS_KIND,
                            requestId: request.requestId,
                            stage: "installing_adapter",
                        }),
                    );
                }
            }
            expect(await screen.findByText("Installing or locating the ACP adapter.")).toBeTruthy();

            for (const request of requests) {
                const label = request.agentId === "codex" ? "Codex" : "Pi";
                paired.daemon.send(
                    encodeAgentInstallFailedEvent({
                        agentId: request.agentId,
                        code: "agent_not_installed",
                        kind: "agent.integration.install.failed",
                        message: `Install ${label} on this machine, then check local Agents again.`,
                        requestId: request.requestId,
                    }),
                );
            }
            expect(
                await screen.findByText("Install Codex on this machine, then check local Agents again."),
            ).toBeTruthy();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a local Agent is detected but its integration is unavailable, When the Web user opens the channel, Then Web shows automatic setup without a manual integration action", async () => {
        const paired = await pairDaemon({
            agents: [],
            installableAgents: [new AgentIntegrationOption("codex", "Codex", "/opt/local/bin/codex", "codex 0.153.0")],
        });
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            await screen.findByRole("heading", {
                level: 1,
                name: "Local Agents",
            });
            expect(await screen.findByText("Agent detected")).toBeTruthy();
            expect(screen.getByText("codex 0.153.0")).toBeTruthy();
            expect(screen.getByText("/opt/local/bin/codex")).toBeTruthy();
            expect(
                screen.getByText(
                    "Mobius detected this Agent and automatically installs and verifies its integration while the daemon is online.",
                ),
            ).toBeTruthy();
            expect(screen.queryByRole("button", { name: "Install integration" })).toBeNull();
            expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given chat has a ready Agent and other local Agents need setup, When the conversation sidebar opens, Then setup cards stay out of the sidebar", async () => {
        const paired = await pairDaemon({
            installableAgents: [{ id: "pi", label: "Pi", status: "agent_not_installed" }],
        });
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            await screen.findByRole("button", { name: "New chat" });
            expect(screen.queryByRole("heading", { name: "Agent integrations" })).toBeNull();
            expect(screen.queryByText("Pi")).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });
});
