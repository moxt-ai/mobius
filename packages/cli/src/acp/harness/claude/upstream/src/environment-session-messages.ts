import { getSessionMessages, importSessionToStore, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { withDeadline, withEnvironment } from "./utils.js";

export type EnvironmentSessionMessage = SessionMessage & {
    readonly nativeOrigin?: unknown;
    readonly nativeToolUseResult?: unknown;
};

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
): Promise<readonly EnvironmentSessionMessage[]> {
    return withEnvironment(environment, () =>
        withDeadline(signal, SESSION_MESSAGES_TIMEOUT_MILLISECONDS, async () => {
            const messages = await getSessionMessages(sessionId);
            // The SDK projection omits native provenance, structured tool results, and error categories.
            // Read those through its transcript API; keep ordering and
            // conversation-chain selection in getSessionMessages, and never
            // classify a diagnostic by its human-readable text.
            const authenticationFailures = new Set<string>();
            const nativeMetadata = new Map<
                string,
                { readonly nativeOrigin?: unknown; readonly nativeToolUseResult?: unknown }
            >();
            await importSessionToStore(
                sessionId,
                {
                    append: async (_key, entries) => {
                        signal.throwIfAborted();
                        for (const entry of entries) {
                            if (entry.type === "user" && typeof entry.uuid === "string") {
                                nativeMetadata.set(entry.uuid, {
                                    nativeOrigin: entry["origin"],
                                    nativeToolUseResult: entry["toolUseResult"],
                                });
                            }
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
            return messages
                .filter((message) => !authenticationFailures.has(message.uuid))
                .map((message) => ({ ...message, ...nativeMetadata.get(message.uuid) }));
        }),
    );
}
