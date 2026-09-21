import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import {
    archiveSegments,
    archiveWork,
    artifacts,
    immutableContent,
    interactions,
    pendingWork,
    sessionContentChunks,
    sessionEventReceipts,
    sessionEvents,
    sessionMessageChunks,
    sessionMessages,
    sessionStreamBlocks,
    sessionStreamEventRefs,
    sessionStreams,
    sessions,
    toolCallViews,
    turnContentViews,
    turnMessageAnchors,
    turns,
    uploadedArtifacts,
} from "../schema/non-cloud-retention-session-relay-do/index.ts";

const terminalTurnStates = ["succeeded", "failed", "cancelled"] as const;

export interface RetainedTerminalTurn {
    readonly commandId: string;
    readonly commandJson: string;
    readonly scopeKey: string;
    readonly sessionId: string;
}

export interface RedactedTerminalTurn {
    readonly commandId: string;
    readonly commandJson: string;
    readonly scopeKey: string;
    readonly sessionId: string;
}

function sourceSequenceIsLater(candidate: string, current: string): boolean {
    return candidate.length > current.length || (candidate.length === current.length && candidate > current);
}

export class NonCloudRetentionSessionStorage {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
    }

    readonly readTerminalTurns = (): readonly RetainedTerminalTurn[] =>
        drizzle(this.#storage)
            .select({
                commandId: turns.commandId,
                commandJson: turns.commandJson,
                scopeKey: turns.scopeKey,
                sessionId: turns.sessionId,
            })
            .from(turns)
            .where(inArray(turns.state, terminalTurnStates))
            .all();

    readonly scrubRetainedContent = (redactedTurns: readonly RedactedTerminalTurn[]): void => {
        const database = drizzle(this.#storage);
        database.transaction((transaction) => {
            const latestEvents = new Map<string, typeof sessionEvents.$inferSelect>();
            for (const event of transaction.select().from(sessionEvents).all()) {
                const key = `${event.scopeKey}\u0000${event.sessionId}\u0000${event.sourceKind}\u0000${event.sourceId}`;
                const current = latestEvents.get(key);
                if (current === undefined || sourceSequenceIsLater(event.sourceSeq, current.sourceSeq)) {
                    latestEvents.set(key, event);
                }
            }
            const receipts = new Map(
                transaction
                    .select()
                    .from(sessionEventReceipts)
                    .all()
                    .map((receipt) => [
                        `${receipt.scopeKey}\u0000${receipt.sessionId}\u0000${receipt.sourceKind}\u0000${receipt.sourceId}`,
                        receipt,
                    ]),
            );
            for (const [key, event] of latestEvents) {
                const receipt = receipts.get(key);
                if (receipt !== undefined && !sourceSequenceIsLater(event.sourceSeq, receipt.sourceSeq)) {
                    continue;
                }
                transaction
                    .insert(sessionEventReceipts)
                    .values({
                        eventId: event.eventId,
                        payloadHash: event.payloadHash,
                        recordedAt: event.recordedAt,
                        scopeKey: event.scopeKey,
                        sequenceNumber: event.sequenceNumber,
                        sessionId: event.sessionId,
                        sourceId: event.sourceId,
                        sourceKind: event.sourceKind,
                        sourceSeq: event.sourceSeq,
                    })
                    .onConflictDoUpdate({
                        target: [
                            sessionEventReceipts.scopeKey,
                            sessionEventReceipts.sessionId,
                            sessionEventReceipts.sourceKind,
                            sessionEventReceipts.sourceId,
                        ],
                        set: {
                            eventId: event.eventId,
                            payloadHash: event.payloadHash,
                            recordedAt: event.recordedAt,
                            sequenceNumber: event.sequenceNumber,
                            sourceSeq: event.sourceSeq,
                        },
                    })
                    .run();
            }

            transaction.delete(archiveSegments).run();
            transaction.delete(archiveWork).run();
            transaction.delete(artifacts).run();
            transaction.delete(immutableContent).run();
            transaction.delete(sessionContentChunks).run();
            transaction.delete(sessionEvents).run();
            transaction.delete(sessionMessageChunks).run();
            transaction.delete(sessionMessages).run();
            transaction.delete(sessionStreamBlocks).run();
            transaction.delete(sessionStreamEventRefs).run();
            transaction.delete(sessionStreams).run();
            transaction.delete(toolCallViews).run();
            transaction.delete(turnContentViews).run();
            transaction.delete(turnMessageAnchors).run();
            transaction.delete(uploadedArtifacts).run();
            transaction
                .delete(interactions)
                .where(inArray(interactions.state, ["resolved", "expired", "cancelled"]))
                .run();

            for (const turn of redactedTurns) {
                transaction
                    .update(turns)
                    .set({ commandJson: turn.commandJson, errorMessage: null, response: "" })
                    .where(
                        and(
                            eq(turns.scopeKey, turn.scopeKey),
                            eq(turns.sessionId, turn.sessionId),
                            eq(turns.commandId, turn.commandId),
                            inArray(turns.state, terminalTurnStates),
                        ),
                    )
                    .run();
            }
            transaction
                .update(pendingWork)
                .set({ deliveryPayload: null })
                .where(inArray(pendingWork.state, ["completed", "failed"]))
                .run();
            transaction.update(sessions).set({ nativeHistoryJson: null, title: "" }).run();
        });
    };
}
