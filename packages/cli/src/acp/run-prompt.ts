import { LocalAgentDefinition } from "../config.ts";
import type { AcpActivity } from "./activity.ts";
import {
  AcpExecutionError,
  type AcpPromptResult,
  AcpSessionManager,
} from "./session-manager.ts";

export interface RunAcpPromptOptions {
  readonly agentArguments: readonly string[];
  readonly agentCommand: string;
  readonly cwd: string;
  readonly onActivity: (activity: AcpActivity) => Promise<void>;
  readonly onText: (text: string) => Promise<void>;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export type { AcpPromptResult };
export { AcpExecutionError };

export async function runAcpPrompt(
  options: RunAcpPromptOptions,
): Promise<AcpPromptResult> {
  const sessions = new AcpSessionManager();
  try {
    return await sessions.runPrompt({
      agent: new LocalAgentDefinition(
        "test-agent",
        "Test agent",
        options.agentCommand,
        options.agentArguments,
      ),
      cwd: options.cwd,
      onActivity: options.onActivity,
      onText: options.onText,
      prompt: options.prompt,
      sessionId: crypto.randomUUID(),
      signal: options.signal,
    });
  } finally {
    await sessions.close();
  }
}
