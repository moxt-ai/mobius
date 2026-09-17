import { act, cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { MobiusChat, readChannelConnection } from "../src/index.ts";
import {
    pairDaemon,
    saveBrowserCredential,
    setupWebIntegrationEnvironment,
    waitForDocumentState,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Embedded Mobius chat", () => {
    it("Given a paired machine has no detected Agent, When a workspace opens Chat, Then a loading indicator gives way to Agent status and a global recheck action", async ({
        signal,
    }) => {
        const paired = await pairDaemon({
            agents: [],
            installableAgents: [{ id: "codex", label: "Codex", status: "agent_not_installed" }],
        });
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        const connection = await readChannelConnection(paired.channelId, AbortSignal.timeout(15_000));
        vi.useFakeTimers({ now: new Date("2026-09-08T00:00:00Z") });
        try {
            // MobiusChat is the complete public application mounted by host workspaces.
            // It uses the real Worker and a stateful daemon at the protocol boundary.
            render(<MobiusChat connection={connection} />);
            expect(screen.getByRole("status", { name: "Loading Mobius chat" })).toBeTruthy();
            expect(screen.queryByText("Loading Mobius chat…")).toBeNull();
            await waitForDocumentState(() => screen.queryByRole("heading", { name: "Local Agents" }) !== null, signal);
            await act(async () => {});
            expect(screen.getByRole("heading", { name: "Local Agents" })).toBeTruthy();
            expect(screen.getByText("Codex")).toBeTruthy();
            expect(screen.getByText("Not installed")).toBeTruthy();
            expect(
                screen.getByText(
                    /Mobius automatically installs and verifies integrations while detecting local Agents\. Install any missing Agent CLI yourself/,
                ),
            ).toBeTruthy();
            expect(screen.queryByRole("button", { name: "Install integration" })).toBeNull();
            expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
            expect(screen.queryByText("Preparing Mobius chat…")).toBeNull();
            expect(screen.queryByRole("status", { name: "Loading Mobius chat" })).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
            vi.useRealTimers();
        }
    });
});
