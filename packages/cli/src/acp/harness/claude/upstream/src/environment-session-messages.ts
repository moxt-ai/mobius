import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { withDeadline, withEnvironment } from "./utils.js";

const SESSION_MESSAGES_TIMEOUT_MILLISECONDS = 30_000;

/**
 * Read a session's message history under `environment`.
 *
 * The SDK is called in-process rather than resolved to a module URL and loaded
 * inside a worker: when this Agent is bundled into a single CJS entry there is
 * no installable package left on disk for a worker to import, so a dynamic
 * `import(specifier)` cannot resolve it. The environment the worker used to carry
 * is applied by {@link withEnvironment} instead.
 */
export function getEnvironmentSessionMessages(
    environment: Readonly<NodeJS.ProcessEnv>,
    sessionId: string,
    signal: AbortSignal,
): Promise<readonly SessionMessage[]> {
    return withEnvironment(environment, () =>
        withDeadline(signal, SESSION_MESSAGES_TIMEOUT_MILLISECONDS, () => getSessionMessages(sessionId)),
    );
}
