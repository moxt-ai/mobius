import { act, cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { MobiusChat, readChannelConnection } from "../../web-core/src/index.ts";
import {
  pairDaemon,
  saveBrowserCredential,
  setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Embedded Mobius chat", () => {
  it("Given a paired machine has no installed Agent, When a workspace opens Chat, Then it offers Agent installation instead of preparing forever", async () => {
    const paired = await pairDaemon({
      agents: [],
      installableAgents: [{ id: "codex", label: "Codex" }],
    });
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    const connection = await readChannelConnection(
      paired.channelId,
      AbortSignal.timeout(15_000),
    );
    vi.useFakeTimers({ now: new Date("2026-09-08T00:00:00Z") });
    let observer: MutationObserver | undefined;
    try {
      const settled = new Promise<void>((resolve) => {
        observer = new MutationObserver(() => {
          if (
            screen.queryByText("Preparing Mobius chat…") !== null ||
            screen.queryByRole("heading", { name: "Install a local Agent" }) !==
              null
          )
            resolve();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      // MobiusChat is the complete public application mounted by host workspaces.
      // It uses the real Worker and a stateful daemon at the protocol boundary.
      render(<MobiusChat connection={connection} />);
      await settled;
      await act(async () => {});
      expect(
        screen.getByRole("heading", { name: "Install a local Agent" }),
      ).toBeTruthy();
      expect(screen.getByText("Codex")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
      expect(screen.queryByText("Preparing Mobius chat…")).toBeNull();
    } finally {
      observer?.disconnect();
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
      vi.useRealTimers();
    }
  });
});
