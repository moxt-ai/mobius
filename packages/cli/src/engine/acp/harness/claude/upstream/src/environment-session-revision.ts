import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { withDeadline, withEnvironment } from "./utils.js";

const SESSION_REVISION_TIMEOUT_MILLISECONDS = 30_000;

/**
 * Identify the latest main-conversation message in a session's transcript under
 * `environment` that the session's own query did not write, or return an empty
 * string when there is none.
 *
 * Claude Code chains each new message to the last one its process holds in memory,
 * so a new message from another client means this query continues an earlier copy.
 * The query's own messages are excluded because the CLI may flush them after the
 * turn completes. Metadata such as titles and prompt pointers is not conversation.
 */
export function getEnvironmentSessionRevision(
    environment: Readonly<NodeJS.ProcessEnv>,
    sessionId: string,
    cwd: string,
    ownMessageIds: ReadonlySet<string>,
    signal: AbortSignal,
): Promise<string> {
    return withEnvironment(environment, () =>
        withDeadline(signal, SESSION_REVISION_TIMEOUT_MILLISECONDS, async () => {
            const messages = await getSessionMessages(sessionId, { dir: cwd });
            return messages.findLast((message) => !ownMessageIds.has(message.uuid))?.uuid ?? "";
        }),
    );
}
