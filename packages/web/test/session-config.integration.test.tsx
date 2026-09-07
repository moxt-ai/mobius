import {
  decodeSessionConfigureCommand,
  decodeSessionPrepareCommand,
  SESSION_CONFIGURE_KIND,
  SESSION_PREPARE_KIND,
  type SessionConfigOption,
} from "@moxt-ai/mobius-protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

function groupedModelConfig(): readonly SessionConfigOption[] {
  return [
    {
      booleanValue: false,
      category: "model",
      currentValue: "deepseek-official/deepseek-v4-flash",
      description: "Execution model",
      id: "model",
      name: "Model",
      type: "select",
      values: [
        {
          description: "Official DeepSeek route",
          groupId: "deepseek-official",
          groupName: "DeepSeek Official",
          name: "DeepSeek V4 Flash",
          value: "deepseek-official/deepseek-v4-flash",
        },
        {
          description: "User-configured model",
          groupId: "custom-provider",
          groupName: "Custom Provider",
          name: "GPT-5.5",
          value: "custom-provider/gpt-5.5",
        },
        {
          description: "User-configured model",
          groupId: "custom-provider",
          groupName: "Custom Provider",
          name: "GPT-5.6 Sol",
          value: "custom-provider/gpt-5.6-sol",
        },
      ],
    },
  ];
}

describe.sequential("Session configuration", () => {
  it("Given an Agent advertises models from multiple provider groups, When the user opens the model picker, Then Mobius presents accessible provider groups and submits only the advertised model value", async () => {
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
      await sendReadySession(paired.daemon, prepare, groupedModelConfig());

      fireEvent.click(
        await screen.findByRole("button", {
          name: /Run settings: DeepSeek V4 Flash/,
        }),
      );
      const modelPicker = screen.getByRole("combobox", { name: "Model" });
      fireEvent.pointerDown(modelPicker, {
        button: 0,
        pointerType: "mouse",
      });

      const officialModels = await screen.findByRole("group", {
        name: "DeepSeek Official",
      });
      expect(
        within(officialModels).getByRole("option", {
          name: "DeepSeek V4 Flash",
        }),
      ).toBeTruthy();
      const customModels = screen.getByRole("group", {
        name: "Custom Provider",
      });
      expect(
        within(customModels)
          .getAllByRole("option")
          .map((option) => (option.textContent ?? "").trim()),
      ).toEqual(["GPT-5.5", "GPT-5.6 Sol"]);

      fireEvent.click(
        within(customModels).getByRole("option", { name: "GPT-5.6 Sol" }),
      );
      const configured = decodeSessionConfigureCommand(
        await paired.daemon.receive(SESSION_CONFIGURE_KIND),
      );
      expect(configured).toMatchObject({
        agentId: "codex",
        configId: "model",
        sessionId: prepare.sessionId,
        value: "custom-provider/gpt-5.6-sol",
      });
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });
});
