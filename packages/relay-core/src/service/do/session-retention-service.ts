import { redactTurnCommand } from "../../entity/do/session-retention.ts";
import type { SessionRetentionStorage } from "../../storage/do/session-retention-storage.ts";

function isTerminal(state: string): boolean {
    return state === "succeeded" || state === "failed" || state === "cancelled";
}

export class SessionRetentionService {
    readonly #storage: SessionRetentionStorage;

    constructor(storage: SessionRetentionStorage) {
        this.#storage = storage;
    }

    readonly scrubNonRetainedContent = (): void => {
        for (const scope of this.#storage.listNonRetainedSessions()) {
            const content = this.#storage.readContent(scope);
            this.#storage.scrubContent(scope, {
                turns: content.turns
                    .filter((turn) => isTerminal(turn.state))
                    .map((turn) => ({ id: turn.id, commandJson: redactTurnCommand(turn.commandJson) })),
                attemptIds: content.attempts
                    .filter((attempt) => isTerminal(attempt.state))
                    .map((attempt) => attempt.id),
                interactionIds: content.interactions
                    .filter((interaction) => ["resolved", "expired", "cancelled"].includes(interaction.state))
                    .map((interaction) => interaction.id),
                workIds: content.work
                    .filter((work) => work.state === "completed" || work.state === "failed")
                    .map((work) => work.id),
            });
        }
    };
}
