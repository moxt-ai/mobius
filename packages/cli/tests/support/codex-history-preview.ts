import { CodexAdapter } from "../../src/acp/adapter/codex/adapter.ts";
import type { AcpAgentDefinition } from "../../src/acp/agent/agent-definition.ts";
import { AcpContentExternalizer } from "../../src/acp/content/content-externalizer.ts";
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
