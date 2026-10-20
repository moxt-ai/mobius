import { describe, expect, it } from "vitest";
import { acpAdapters } from "../../src/acp/adapter/registry.ts";
import { AgentRuntimeManager } from "../../src/acp/agent-runtime-manager.ts";
import { NullAcpSessionObserver } from "../../src/acp/session-contracts.ts";
import { MemoryAcpSessionStore } from "../../src/acp/session-store.ts";
import { LocalAgentDefinition } from "../../src/daemon/config.ts";
import { systemTimer } from "../../src/daemon/relay/timer.ts";
import { AcpContentExternalizer } from "../../src/external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../../src/external-content/local-external-content-store.ts";
import { fakeAgentPath } from "./acp-feature-fixture.ts";

const contextUsage = { used: 50_000, size: 200_000, cost: { amount: 0.125, currency: "USD" } };

function usageAgent(): LocalAgentDefinition {
    return new LocalAgentDefinition("controlled-usage", "Controlled ACP", process.execPath, [fakeAgentPath], {
        MOBIUS_FAKE_ACP_CONTEXT_USAGE: JSON.stringify(contextUsage),
    });
}

function createManager(store: MemoryAcpSessionStore): AgentRuntimeManager {
    return new AgentRuntimeManager({
        observer: new NullAcpSessionObserver(),
        store,
        adapters: acpAdapters,
        sessionIdentity: "assigned",
        onSessionStatusChanged: () => undefined,
        contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
        timer: systemTimer,
        maxProcesses: null,
    });
}

describe("Session usage and settings reads across a daemon restart", () => {
    it("Given a session reported usage, When the runtime restarts, Then a usage read returns the persisted snapshot", async () => {
        const store = new MemoryAcpSessionStore();
        const sessionId = "restart-usage-session";
        const first = createManager(store);
        try {
            await first.runPrompt({
                additionalDirectories: [],
                agent: usageAgent(),
                commandId: "restart-usage-command",
                cwd: process.cwd(),
                images: [],
                resources: [],
                sessionId,
                prompt: "Complete this turn",
                signal: AbortSignal.timeout(10_000),
            });
        } finally {
            await first.close();
        }

        // A restarted daemon retains only the persisted session store.
        const restarted = createManager(store);
        try {
            const usage = await restarted.readSessionUsage(sessionId, AbortSignal.timeout(10_000));
            expect(usage).toMatchObject({
                cost: { amount: 0.125, currency: "USD" },
                size: 200_000,
                used: 50_000,
            });
        } finally {
            await restarted.close();
        }
    });

    it("Given a session never reported usage, When usage is read, Then the snapshot is null", async () => {
        const manager = createManager(new MemoryAcpSessionStore());
        try {
            const agent = new LocalAgentDefinition("controlled-usage", "Controlled ACP", process.execPath, [
                fakeAgentPath,
            ]);
            await manager.prepareSession({
                additionalDirectories: [],
                agent,
                cwd: process.cwd(),
                sessionId: "no-usage-session",
                signal: AbortSignal.timeout(10_000),
            });
            await expect(manager.readSessionUsage("no-usage-session", AbortSignal.timeout(10_000))).resolves.toBeNull();
        } finally {
            await manager.close();
        }
    });

    it("Given an unknown session, When usage is read, Then the read fails with session_not_found", async () => {
        const manager = createManager(new MemoryAcpSessionStore());
        try {
            await expect(
                manager.readSessionUsage("missing-session", AbortSignal.timeout(10_000)),
            ).rejects.toMatchObject({ code: "session_not_found" });
        } finally {
            await manager.close();
        }
    });
});
