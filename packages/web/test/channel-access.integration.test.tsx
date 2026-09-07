import {
  decodeSessionPrepareCommand,
  SESSION_PREPARE_KIND,
} from "@moxt-ai/mobius-protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

describe.sequential("Channel access boundaries", () => {
  it("Given an owned paired Channel, When device access is opened from the conversation sidebar, Then it appears outside Agent settings", async () => {
    const paired = await pairDaemon();
    const settingsPath = `/channels/${encodeURIComponent(paired.channelId)}/settings`;
    const accessPath = `/channels/${encodeURIComponent(paired.channelId)}/access`;
    window.history.replaceState(null, "", settingsPath);
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      await screen.findByRole("heading", { level: 1, name: "Agent settings" });
      expect(
        screen.queryByRole("button", {
          name: "Create one-time access link",
        }),
      ).toBeNull();

      fireEvent.click(
        screen.getByRole("link", { name: "Access from other devices" }),
      );

      await screen.findByRole("heading", {
        level: 1,
        name: "Access from other devices",
      });
      expect(window.location.pathname).toBe(accessPath);
      expect(
        await screen.findByRole("button", {
          name: "Create one-time access link",
        }),
      ).toBeTruthy();
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given an owned paired Channel, When its one-time access link is opened in another browser, Then that browser receives revocable access without a Mobius account", async () => {
    const paired = await pairDaemon();
    const accessPath = `/channels/${encodeURIComponent(paired.channelId)}/access`;
    window.history.replaceState(null, "", accessPath);
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      await screen.findByRole("heading", {
        level: 1,
        name: "Access from other devices",
      });
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Create one-time access link",
        }),
      );
      const accessLinkInput = await screen.findByRole("textbox", {
        name: "One-time access link",
      });
      const accessLink = accessLinkInput.getAttribute("value") ?? "";
      expect(accessLink).toContain(
        `/channels/${encodeURIComponent(paired.channelId)}#access=`,
      );
      expect(accessLink).not.toContain(paired.credential.hostToken);

      cleanup();
      await closeMobiusTransport();
      window.localStorage.clear();
      window.history.replaceState(null, "", accessLink);
      render(<App />);

      const linkedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, linkedPreparation);
      await screen.findByRole("textbox", { name: "Message the local agent" });
      expect(window.location.hash).toBe("");
      const linkedCredential = window.localStorage.getItem(
        `mobius:channel-credential:${paired.channelId}`,
      );
      expect(linkedCredential).not.toBeNull();
      expect(linkedCredential).not.toContain(paired.credential.hostToken);

      cleanup();
      await closeMobiusTransport();
      window.localStorage.clear();
      saveBrowserCredential(paired.channelId, paired.credential);
      window.history.replaceState(null, "", accessPath);
      render(<App />);

      const linkedDevices = await screen.findByRole("list", {
        name: "Linked devices",
      });
      expect(within(linkedDevices).getAllByRole("listitem")).toHaveLength(1);
      fireEvent.click(
        within(linkedDevices).getByRole("button", {
          name: /Revoke linked device/,
        }),
      );
      await waitFor(() => {
        expect(
          screen.getByText("No other devices currently have access."),
        ).toBeTruthy();
      });

      cleanup();
      await closeMobiusTransport();
      window.localStorage.clear();
      if (linkedCredential === null) {
        throw new Error("Expected a linked browser credential");
      }
      window.localStorage.setItem(
        `mobius:channel-credential:${paired.channelId}`,
        linkedCredential,
      );
      window.history.replaceState(null, "", accessPath);
      render(<App />);

      expect(
        await screen.findByText(
          "unauthorized: A valid channel token is required",
        ),
      ).toBeTruthy();

      cleanup();
      await closeMobiusTransport();
      window.localStorage.clear();
      saveBrowserCredential(paired.channelId, paired.credential);
      window.history.replaceState(null, "", accessPath);
      render(<App />);

      fireEvent.click(
        await screen.findByRole("button", {
          name: "Create one-time access link",
        }),
      );
      const renewedAccessLink = (
        await screen.findByRole("textbox", {
          name: "One-time access link",
        })
      ).getAttribute("value");
      if (renewedAccessLink === null) {
        throw new Error("Expected a renewed access link");
      }

      cleanup();
      await closeMobiusTransport();
      window.localStorage.setItem(
        `mobius:channel-credential:${paired.channelId}`,
        linkedCredential,
      );
      window.history.replaceState(null, "", renewedAccessLink);
      render(<App />);

      await screen.findByRole("textbox", { name: "Message the local agent" });
      expect(window.location.hash).toBe("");
      expect(
        window.localStorage.getItem(
          `mobius:channel-credential:${paired.channelId}`,
        ),
      ).not.toBe(linkedCredential);
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });
});
