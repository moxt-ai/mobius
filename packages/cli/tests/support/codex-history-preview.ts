import { methods } from "@agentclientprotocol/sdk";
import { initializeAgentConnection, validateAgentRuntime } from "../../src/acp/adapter/agent-initialization.ts";
import { CodexAdapter } from "../../src/acp/adapter/codex/adapter.ts";
import type { AcpAgentDefinition } from "../../src/acp/agent/agent-definition.ts";
import { AcpContentExternalizer } from "../../src/acp/content/content-externalizer.ts";
import { MemorySessionEventStore } from "../../src/session/history/session-event-store.ts";
import { AgentProcessPool } from "../../src/session/process/agent-process-pool.ts";
import { UnretainedExternalContentStore } from "./unretained-external-content-store.ts";

function historyAdapter() {
    const processes = new AgentProcessPool();
    const content = new UnretainedExternalContentStore();
    const adapter = new CodexAdapter({
        processes,
        contentExternalizer: new AcpContentExternalizer((sessionId, value, signal) =>
            content.put({
                bytes: value.bytes,
                kind: value.kind,
                mediaType: value.mediaType,
                name: value.name,
                sessionId,
                signal,
            }),
        ),
    });
    return { adapter, processes };
}

/** Exercises the production preview boundary against a controlled app-server executable. */
export async function previewCodexHistory(agent: AcpAgentDefinition, cwd: string, nativeSessionId: string) {
    const { adapter, processes } = historyAdapter();
    try {
        return await adapter.previewSessionEvents(
            { agent, cwd, additionalDirectories: [], sessionId: "preview", signal: AbortSignal.timeout(30_000) },
            {
                nativeSessionId,
                sessionId: "preview",
                eventLimit: 500,
                cursor: null,
            },
        );
    } finally {
        await adapter.close();
        await processes.stopIdleReclamation();
    }
}

/** Reads through the normal ACP session/load lifecycle for parity assertions. */
export async function loadCodexHistory(agent: AcpAgentDefinition, cwd: string, nativeSessionId: string) {
    const { adapter, processes } = historyAdapter();
    const events = new MemorySessionEventStore();
    try {
        const signal = AbortSignal.timeout(30_000);
        await validateAgentRuntime(agent, signal);
        const rejectInteraction = async (): Promise<never> => {
            throw new Error("History replay must not request interaction");
        };
        const runtime = adapter.connectSession({
            agent,
            cwd,
            sessionId: () => "opened",
            configOptions: () => [],
            onEvent: async (event) => {
                events.append("opened", { type: "acp", payload: event.payload });
            },
            interactions: {
                onPermission: rejectInteraction,
                onElicitation: rejectInteraction,
                onElicitationComplete: rejectInteraction,
            },
        });
        try {
            await initializeAgentConnection(runtime, agent.id, agent.agentVersion, signal);
            events.reset("opened");
            runtime.events.select(nativeSessionId);
            await runtime.race(
                runtime.connection.agent.request(
                    methods.agent.session.load,
                    {
                        sessionId: nativeSessionId,
                        cwd,
                        additionalDirectories: [],
                        mcpServers: [],
                    },
                    { cancellationSignal: signal },
                ),
                "Agent exited while opening saved history",
                signal,
            );
            await runtime.events.drained();
            signal.throwIfAborted();
            return events.page("opened", 500, null);
        } finally {
            await runtime.closeProcess();
        }
    } finally {
        try {
            await adapter.close();
        } finally {
            events.close();
            await processes.stopIdleReclamation();
        }
    }
}
