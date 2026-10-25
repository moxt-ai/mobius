import { getSessionMessages, importSessionToStore, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
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
        withDeadline(signal, SESSION_MESSAGES_TIMEOUT_MILLISECONDS, async () => {
            const messages = await getSessionMessages(sessionId);
            if (
                !messages.some(
                    ({ type, message }) =>
                        type === "assistant" &&
                        typeof message === "object" &&
                        message !== null &&
                        "model" in message &&
                        message.model === "<synthetic>",
                )
            ) {
                return messages;
            }
            // The SDK's message projection omits the structured error category.
            // Read that metadata through its transcript API; keep ordering and
            // conversation-chain selection in getSessionMessages, and never
            // classify a diagnostic by its human-readable text.
            const authenticationFailures = new Set<string>();
            await importSessionToStore(
                sessionId,
                {
                    append: async (_key, entries) => {
                        signal.throwIfAborted();
                        for (const entry of entries) {
                            if (
                                entry.type === "assistant" &&
                                entry["error"] === "authentication_failed" &&
                                typeof entry.uuid === "string"
                            ) {
                                authenticationFailures.add(entry.uuid);
                            }
                        }
                    },
                    load: async () => null,
                },
                { includeSubagents: false },
            );
            signal.throwIfAborted();
            return messages.filter((message) => !authenticationFailures.has(message.uuid));
        }),
    );
}
