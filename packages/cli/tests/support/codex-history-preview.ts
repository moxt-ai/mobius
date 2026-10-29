import { validateAgentRuntime } from "../../src/engine/acp/adapter/agent-initialization.ts";
import { CodexAdapter } from "../../src/engine/acp/adapter/codex/adapter.ts";
import type { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import type { AdapterSessionCreateParams } from "../../src/engine/acp/native-history/preview-contract.ts";
import { MemorySessionEventStore } from "../../src/engine/session/history/session-event-store.ts";
import { AgentProcessPool } from "../../src/engine/session/process/agent-process-pool.ts";
import { UnretainedExternalContentStore } from "./unretained-external-content-store.ts";

function historyAdapter(agent: AcpAgentDefinition) {
    const processes = new AgentProcessPool();
    const content = new UnretainedExternalContentStore();
    const adapter = new CodexAdapter(agent, {
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
    const { adapter, processes } = historyAdapter(agent);
    try {
        return await adapter.readSessionHistory({
            query: { agent, cwd, additionalDirectories: [], signal: AbortSignal.timeout(30_000) },
            request: {
                nativeSessionId,
                eventLimit: 500,
                cursor: null,
            },
        });
    } finally {
        await adapter.close();
        await processes.stopIdleReclamation();
    }
}

/** Reads through the normal ACP session/load lifecycle for parity assertions. */
export async function loadCodexHistory(agent: AcpAgentDefinition, cwd: string, nativeSessionId: string) {
    const { adapter, processes } = historyAdapter(agent);
    const events = new MemorySessionEventStore();
    try {
        const signal = AbortSignal.timeout(30_000);
        await validateAgentRuntime(agent, signal);
        const rejectInteraction = async (): Promise<never> => {
            throw new Error("History replay must not request interaction");
        };
        const params: AdapterSessionCreateParams = {
            scope: { agent, cwd, additionalDirectories: [] },
            signal,
            onSessionEvent: async (_nativeSessionId, event) => {
                events.append("opened", { type: "acp", payload: event.payload });
            },
            interactions: {
                onPermission: rejectInteraction,
                onElicitation: rejectInteraction,
                onElicitationComplete: rejectInteraction,
            },
        };
        try {
            events.reset("opened");
            await adapter.openSessionWithReplay({ ...params, nativeSessionId });
            signal.throwIfAborted();
            return events.page("opened", 500, null);
        } finally {
            await adapter.releaseSession({
                cwd,
                additionalDirectories: [],
                nativeSessionId,
                signal: AbortSignal.timeout(30_000),
            });
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
