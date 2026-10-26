import { CodexAdapter } from "../../src/acp/adapter/codex/adapter.ts";
import { AcpQuerySession } from "../../src/acp/adapter/query-session.ts";
import { AcpSessionConnector } from "../../src/acp/adapter/session-events.ts";
import type { AcpAgentDefinition } from "../../src/acp/agent/agent-definition.ts";
import { AcpContentExternalizer } from "../../src/acp/content/content-externalizer.ts";
import { MemorySessionEventStore } from "../../src/session/history/session-event-store.ts";
import { AgentProcessPool } from "../../src/session/process/agent-process-pool.ts";
import { UnretainedExternalContentStore } from "./unretained-external-content-store.ts";

/** Exercises the production preview boundary against a controlled app-server executable. */
export async function previewCodexHistory(agent: AcpAgentDefinition, cwd: string, nativeSessionId: string) {
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
    const content = new UnretainedExternalContentStore();
    const connector = new AcpSessionConnector(
        new AcpContentExternalizer((sessionId, value, signal) =>
            content.put({
                bytes: value.bytes,
                kind: value.kind,
                mediaType: value.mediaType,
                name: value.name,
                sessionId,
                signal,
            }),
        ),
    );
    const events = new MemorySessionEventStore();
    try {
        const signal = AbortSignal.timeout(30_000);
        const runtime = await AcpQuerySession.start(
            { agent, cwd, additionalDirectories: [], sessionId: "opened", signal },
            events,
            connector,
        );
        try {
            return await runtime.previewEvents(nativeSessionId, 500, signal);
        } finally {
            await runtime.closeProcess();
        }
    } finally {
        events.close();
    }
}
