import {
    AGENT_INSTALL_REQUEST_KIND,
    decodeAgentInstallRequestCommand,
    encodeAgentInstallFailedEvent,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "@/app";
import { AgentIntegrationOption } from "@/domain/channel";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { pairDaemon, saveBrowserCredential, setupWebIntegrationEnvironment } from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Agent integration installation", () => {
    it("Given a paired machine has not detected a local Agent, When the Web user requests its integration, Then Web identifies the missing Agent and asks the user to install it locally", async () => {
        const paired = await pairDaemon({
            agents: [],
            installableAgents: [{ id: "codex", label: "Codex", status: "agent_not_installed" }],
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
            expect(await screen.findByText("Not installed")).toBeTruthy();

            const install = screen.getByRole("button", {
                name: "Install integration",
            });
            await waitFor(() => {
                expect(install.hasAttribute("disabled")).toBe(false);
            });
            fireEvent.click(install);
            const request = decodeAgentInstallRequestCommand(await paired.daemon.receive(AGENT_INSTALL_REQUEST_KIND));
            expect(request.agentId).toBe("codex");

            paired.daemon.send(
                encodeAgentInstallFailedEvent({
                    agentId: request.agentId,
                    code: "agent_not_installed",
                    kind: "agent.integration.install.failed",
                    message: "Install Codex on this machine, then try installing the integration again.",
                    requestId: request.requestId,
                }),
            );
            expect(
                await screen.findByText("Install Codex on this machine, then try installing the integration again."),
            ).toBeTruthy();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a local Agent is detected but its integration is unavailable, When the Web user opens the channel, Then Web shows the Agent version and path before offering integration installation", async () => {
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
            expect(screen.getByRole("button", { name: "Install integration" })).toBeTruthy();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });
});
