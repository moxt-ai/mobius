import { LocalAgentDefinition } from "../runtime/config.ts";
import { systemTimer } from "../runtime/relay/timer.ts";
import { acpAdapters } from "./adapter/registry.ts";
import { AcpExecutionError, type AcpPromptResult, AgentRuntimeManager } from "./agent-runtime-manager.ts";
import { AcpContentExternalizer } from "./external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "./external-content/local-external-content-store.ts";
import { NullAcpSessionObserver } from "./session-contracts.ts";
import { MemoryAcpSessionStore } from "./session-store.ts";

interface RunAcpPromptOptions {
    readonly agentArguments: readonly string[];
    readonly agentCommand: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
}

export { AcpExecutionError };

export async function runAcpPrompt(options: RunAcpPromptOptions): Promise<AcpPromptResult> {
    const agentRuntime = new AgentRuntimeManager({
        observer: new NullAcpSessionObserver(),
        store: new MemoryAcpSessionStore(),
        adapters: acpAdapters,
        sessionIdentity: "assigned",
        onSessionStatusChanged: () => undefined,
        contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
        timer: systemTimer,
        maxProcesses: null,
    });
    const commandId = crypto.randomUUID();
    try {
        return await agentRuntime.runPrompt({
            additionalDirectories: [],
            agent: new LocalAgentDefinition("test-agent", "Test agent", options.agentCommand, options.agentArguments),
            cwd: options.cwd,
            commandId,
            images: [],
            lifecycle: {
                attemptId: crypto.randomUUID(),
                content: [{ text: options.prompt, type: "text" }],
                epoch: crypto.randomUUID(),
            },
            prompt: options.prompt,
            resources: [],
            sessionId: crypto.randomUUID(),
            signal: options.signal,
        });
    } finally {
        await agentRuntime.close();
    }
}
