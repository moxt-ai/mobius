import {
  AGENT_INSTALL_REQUEST_KIND,
  decodeAgentInstallRequestCommand,
  encodeAgentInstallCompletedEvent,
  encodeAgentInstallProgressEvent,
  encodeAgentInstallStartedEvent,
} from "@moxt-ai/mobius-protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "@/app";
import { closeMobiusTransport } from "@/services/mobius-transport";
import {
  pairDaemon,
  saveBrowserCredential,
  setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Agent installation", () => {
  it("Given a paired machine offers an installable Agent, When the Web user confirms installation, Then the fixed local recipe starts without another approval", async () => {
    const paired = await pairDaemon({
      agents: [],
      installableAgents: [{ id: "codex", label: "Codex" }],
    });
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      await screen.findByRole("heading", {
        level: 1,
        name: "Install a local Agent",
      });
      expect(screen.queryByText(/local approval required/i)).toBeNull();

      const install = screen.getByRole("button", { name: "Install" });
      await waitFor(() => {
        expect(install.hasAttribute("disabled")).toBe(false);
      });
      fireEvent.click(install);
      const request = decodeAgentInstallRequestCommand(
        await paired.daemon.receive(AGENT_INSTALL_REQUEST_KIND),
      );
      expect(request.agentId).toBe("codex");

      paired.daemon.send(
        encodeAgentInstallStartedEvent({
          agentId: request.agentId,
          kind: "agent.install.started",
          requestId: request.requestId,
        }),
      );
      expect(
        await screen.findByText("Starting the fixed installation recipe."),
      ).toBeTruthy();

      paired.daemon.send(
        encodeAgentInstallProgressEvent({
          agentId: request.agentId,
          kind: "agent.install.progress",
          requestId: request.requestId,
          stage: "downloading",
        }),
      );
      expect(
        await screen.findByText("Downloading from the verified vendor."),
      ).toBeTruthy();

      paired.daemon.send(
        encodeAgentInstallCompletedEvent({
          agentId: request.agentId,
          authenticationMayBeRequired: true,
          kind: "agent.install.completed",
          requestId: request.requestId,
        }),
      );
      expect(await screen.findByRole("button", { name: "Ready" })).toBeTruthy();
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });
});
