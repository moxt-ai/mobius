import { addAbortListener } from "node:events";
import { watch } from "node:fs";

import { listEnvironmentSessions } from "../../../src/engine/acp/harness/claude/upstream/dist/environment-session-list.js";
import {
    type EnvironmentSessionMessage,
    getEnvironmentSessionMessages,
} from "../../../src/engine/acp/harness/claude/upstream/dist/environment-session-messages.js";

/**
 * Returns a session's saved messages once its native transcript contains
 * `messageId`. Prompt completion is a live-output boundary, not a transcript
 * flush: Claude Code may write a turn's messages, and even create the
 * transcript, after the turn completes. Native writes are observed instead of
 * assuming a completed prompt saved them.
 */
export async function waitForSavedClaudeMessage(
    environment: Readonly<Record<string, string>>,
    sessionId: string,
    messageId: string,
    signal: AbortSignal,
): Promise<readonly EnvironmentSessionMessage[]> {
    const configDirectory = environment["CLAUDE_CONFIG_DIR"];
    if (configDirectory === undefined) {
        throw new Error("Expected an isolated Claude configuration directory");
    }
    type NativeWrite = { readonly kind: "changed" } | { readonly kind: "failed"; readonly cause: Error };
    let changed = Promise.withResolvers<NativeWrite>();
    const watcher = watch(configDirectory, { recursive: true }, () => changed.resolve({ kind: "changed" }));
    watcher.on("error", (cause) => changed.resolve({ kind: "failed", cause }));
    using _abort = addAbortListener(signal, () => changed.resolve({ kind: "changed" }));
    try {
        for (;;) {
            signal.throwIfAborted();
            // Subscribe before reading so a write during the read is not missed.
            const notification = changed.promise;
            const sessions = await listEnvironmentSessions(environment, undefined, signal);
            if (sessions.some((session) => session.sessionId === sessionId)) {
                const saved = await getEnvironmentSessionMessages(environment, sessionId, signal);
                if (saved.some((message) => message.uuid === messageId)) {
                    return saved;
                }
            }
            const event = await notification;
            if (event.kind === "failed") {
                throw event.cause;
            }
            changed = Promise.withResolvers<NativeWrite>();
        }
    } finally {
        watcher.close();
    }
}
