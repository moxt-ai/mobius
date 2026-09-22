import type { SessionRetentionReceipt } from "../../entity/do/session-retention-records.ts";
import type { SessionRetentionStorage } from "../../storage/do/session-retention-storage.ts";
import { isLegacyScrubbedTurnCommand, redactTurnCommand } from "./session-turn-content.ts";

function sourceSequenceIsLater(candidate: string, current: string): boolean {
    return candidate.length > current.length || (candidate.length === current.length && candidate > current);
}

function sourceKey(receipt: SessionRetentionReceipt): string {
    return `${receipt.sourceKind}\u0000${receipt.sourceId}`;
}

function isTerminal(state: string): boolean {
    return state === "succeeded" || state === "failed" || state === "cancelled";
}

export class SessionRetentionService {
    readonly #storage: SessionRetentionStorage;

    constructor(storage: SessionRetentionStorage) {
        this.#storage = storage;
    }

    readonly repairLegacyNonRetainedTurns = (): void => {
        for (const scope of this.#storage.listNonRetainedSessions()) {
            const legacy = this.#storage
                .readTurns(scope)
                .filter((turn) => isTerminal(turn.state) && isLegacyScrubbedTurnCommand(turn.commandJson));
            if (legacy.length === 0) {
                continue;
            }
            const turnIds = new Set(legacy.map((turn) => turn.turnId));
            const attemptIds = this.#storage
                .readAttempts(scope)
                .filter((attempt) => isTerminal(attempt.state) && turnIds.has(attempt.turnId))
                .map((attempt) => attempt.id);
            this.#storage.repairTurnContent(
                scope,
                legacy.map((turn) => ({ id: turn.id, commandJson: redactTurnCommand(turn.commandJson) })),
                attemptIds,
            );
        }
    };

    readonly scrubNonRetainedContent = (): void => {
        for (const scope of this.#storage.listNonRetainedSessions()) {
            const content = this.#storage.readContent(scope);
            const receipts = new Map<string, SessionRetentionReceipt>(
                content.receipts.map((receipt) => [sourceKey(receipt), receipt]),
            );
            const updatedReceipts = new Map<string, SessionRetentionReceipt>();
            for (const event of content.events) {
                const key = sourceKey(event);
                const current = receipts.get(key);
                if (current === undefined || sourceSequenceIsLater(event.sourceSeq, current.sourceSeq)) {
                    receipts.set(key, event);
                    updatedReceipts.set(key, event);
                }
            }
            this.#storage.scrubContent(scope, {
                receipts: [...updatedReceipts.values()],
                turns: content.turns
                    .filter((turn) => isTerminal(turn.state))
                    .map((turn) => ({ id: turn.id, commandJson: redactTurnCommand(turn.commandJson) })),
                attemptIds: content.attempts
                    .filter((attempt) => isTerminal(attempt.state))
                    .map((attempt) => attempt.id),
                interactionIds: content.interactions
                    .filter(
                        (interaction) =>
                            interaction.state === "resolved" ||
                            interaction.state === "expired" ||
                            interaction.state === "cancelled",
                    )
                    .map((interaction) => interaction.id),
                workIds: content.work
                    .filter((work) => work.state === "completed" || work.state === "failed")
                    .map((work) => work.id),
            });
        }
    };
}
