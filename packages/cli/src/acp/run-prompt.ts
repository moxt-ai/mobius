import { LocalAgentDefinition } from "../daemon/config.ts";
import { systemDaemonTimer } from "../daemon/relay/timer.ts";
import { AcpContentExternalizer } from "../external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../external-content/local-external-content-store.ts";
import type { AcpActivity, AcpActivityNarration } from "./activity.ts";
import { acpAdapters } from "./adapter/registry.ts";
import { AcpExecutionError, type AcpPromptResult, AgentRuntimeManager } from "./agent-runtime-manager.ts";
import { NullAcpSessionObserver } from "./session-contracts.ts";
import { MemoryAcpSessionStore } from "./session-store.ts";

interface RunAcpPromptOptions {
    readonly agentArguments: readonly string[];
    readonly agentCommand: string;
    readonly cwd: string;
    readonly onActivity?: (activity: AcpActivity) => Promise<void>;
    readonly onNarration?: (narration: AcpActivityNarration) => Promise<void>;
    readonly onText?: (text: string) => Promise<void>;
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
        timer: systemDaemonTimer,
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
            lifecycleV2: {
                attemptId: crypto.randomUUID(),
                content: [{ text: options.prompt, type: "text" }],
                epoch: crypto.randomUUID(),
            },
            ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }),
            ...(options.onNarration === undefined ? {} : { onNarration: options.onNarration }),
            ...(options.onText === undefined ? {} : { onText: options.onText }),
            prompt: options.prompt,
            resources: [],
            sessionId: crypto.randomUUID(),
            signal: options.signal,
        });
    } finally {
        await agentRuntime.close();
    }
}
