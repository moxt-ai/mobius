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
            const command = decodeSessionPromptCommand(turn.command_json);
            return {
                command_id: turn.command_id,
                command_json: encodeSessionPromptCommand({
                    ...command,
                    images: [],
                    prompt: REDACTED_SESSION_PROMPT,
                    resources: [],
                }),
                scope_key: turn.scope_key,
                session_id: turn.session_id,
            };
        });
        this.#storage.scrubRetainedContent(redactedTurns);
    };
}
