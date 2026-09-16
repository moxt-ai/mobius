import { act, cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { MobiusChat, readChannelConnection } from "../../web-core/src/index.ts";
import { pairDaemon, saveBrowserCredential, setupWebIntegrationEnvironment } from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Embedded Mobius chat", () => {
    it("Given a paired machine has no detected Agent, When a workspace opens Chat, Then a loading indicator gives way to the missing Agent and integration action", async () => {
        const paired = await pairDaemon({
            agents: [],
            installableAgents: [{ id: "codex", label: "Codex", status: "agent_not_installed" }],
        });
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        const connection = await readChannelConnection(paired.channelId, AbortSignal.timeout(15_000));
        vi.useFakeTimers({ now: new Date("2026-09-08T00:00:00Z") });
        let observer: MutationObserver | undefined;
        try {
            const settled = new Promise<void>((resolve) => {
                observer = new MutationObserver(() => {
                    if (
                        screen.queryByRole("status", { name: "Preparing Mobius chat" }) !== null ||
                        screen.queryByRole("heading", { name: "Local Agents" }) !== null
                    ) {
                        resolve();
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
            });
            // MobiusChat is the complete public application mounted by host workspaces.
            // It uses the real Worker and a stateful daemon at the protocol boundary.
            render(<MobiusChat connection={connection} />);
            expect(screen.getByRole("status", { name: "Loading Mobius chat" })).toBeTruthy();
            expect(screen.queryByText("Loading Mobius chat…")).toBeNull();
            await settled;
            await act(async () => {});
            expect(screen.getByRole("heading", { name: "Local Agents" })).toBeTruthy();
            expect(screen.getByText("Codex")).toBeTruthy();
            expect(screen.getByText("Not installed")).toBeTruthy();
            expect(
                screen.getByText(
                    /Mobius automatically installs and verifies integrations for detected Agents\. Install any missing Agent CLI yourself/,
                ),
            ).toBeTruthy();
            expect(screen.getByRole("button", { name: "Install integration" })).toBeTruthy();
            expect(screen.queryByText("Preparing Mobius chat…")).toBeNull();
            expect(screen.queryByRole("status", { name: "Loading Mobius chat" })).toBeNull();
        } finally {
            observer?.disconnect();
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
            vi.useRealTimers();
        }
    });
});
