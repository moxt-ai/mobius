import { decodeSessionPromptCommand, encodeSessionPromptCommand } from "@moxt-ai/mobius-protocol";
import type { NonCloudRetentionSessionStorage } from "../storage/non-cloud-retention-session-storage.ts";

const REDACTED_SESSION_PROMPT = "[Content unavailable]";

export class NonCloudRetentionSessionScrubService {
    readonly #storage: NonCloudRetentionSessionStorage;

    constructor(storage: NonCloudRetentionSessionStorage) {
        this.#storage = storage;
    }

    readonly scrubRetainedContent = (): void => {
        const redactedTurns = this.#storage.readTerminalTurns().map((turn) => {
            const command = decodeSessionPromptCommand(turn.commandJson);
            return {
                commandId: turn.commandId,
                commandJson: encodeSessionPromptCommand({
                    ...command,
                    images: [],
                    prompt: REDACTED_SESSION_PROMPT,
                    resources: [],
                }),
                scopeKey: turn.scopeKey,
                sessionId: turn.sessionId,
            };
        });
        this.#storage.scrubRetainedContent(redactedTurns);
    };
}
