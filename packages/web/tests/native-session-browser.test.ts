import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeSessionBrowser } from "@/components/native-session-browser";
import {
  AgentOption,
  ChannelConnection,
  ChannelHistory,
} from "@/domain/channel";
import { useChatStore } from "@/store/chat-store";

describe("local session navigation", () => {
  it("Given installed local Agents and an unprepared chat, When the sidebar is displayed, Then saved sessions can be browsed without preparing or changing that chat", () => {
    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [
            new AgentOption("codex", "Codex"),
            new AgentOption("claude", "Claude Code"),
          ],
          "channel",
          "Local machine",
          "mobius",
        ),
        new ChannelHistory([]),
      );
    const chat = useChatStore.getState().conversations[0];
    const html = renderToStaticMarkup(createElement(NativeSessionBrowser));
    expect(html).toContain("Local sessions");
    expect(useChatStore.getState().conversations[0]).toBe(chat);
  });
});
