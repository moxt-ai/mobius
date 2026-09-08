import {
  decodeSessionPrepareCommand,
  SESSION_PREPARE_KIND,
  type SessionConfigOption,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "@/app";
import { closeMobiusTransport } from "@/services/mobius-transport";
import {
  pairDaemon,
  saveBrowserCredential,
  sendReadySession,
  setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

const unavailableReasoningEffort: SessionConfigOption = {
  booleanValue: false,
  category: "thought_level",
  currentValue: "agent_default",
  description:
    "This Agent does not expose adjustable reasoning effort for the selected model.",
  id: "reasoning_effort",
  name: "Reasoning effort",
  type: "select",
  values: [
    {
      description: "Selected by the Agent",
      groupId: "",
      groupName: "",
      name: "Agent default",
      value: "agent_default",
    },
  ],
};

describe.sequential("Required reasoning effort configuration", () => {
  it("Given reasoning effort is unavailable for the selected Agent model, When the user opens run settings, Then the required setting explains the limitation and cannot submit an invalid change", async () => {
    const paired = await pairDaemon();
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      const prepare = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, prepare, [
        unavailableReasoningEffort,
      ]);

      fireEvent.click(
        await screen.findByRole("button", {
          name: /Run settings: Agent default/,
        }),
      );
      expect(
        screen.getByText(
          "This Agent does not expose adjustable reasoning effort for the selected model.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole("combobox", { name: "Reasoning effort" }),
      ).toHaveProperty("disabled", true);
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });
});
