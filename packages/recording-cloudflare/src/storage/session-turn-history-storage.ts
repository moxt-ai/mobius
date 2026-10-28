import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import {
    emptyProjection,
    type ProjectedEventIdentity,
    type ProjectionWrites,
    type StoredInteractionRecord,
    type StoredProjection,
    type StoredProjectionFailure,
    type StoredTurn,
    type StoredTurnItem,
    type StoredTurnItemRead,
    storedInteractionSchema,
    storedProjectionFailureSchema,
    storedProjectionStateSchema,
    storedTurnItemBytes,
    storedTurnItemSchema,
    storedTurnSchema,
} from "../entity/session-turn-history.ts";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import { RecordingSqlMetrics } from "../infra/recording-sql-metrics.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import {
    projectedSessionEvent,
    recordedInteraction,
    recordedTurn,
    recordedTurnItem,
    recordingProjection,
} from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

// Each identity binds two parameters, within Durable Object SQLite's 100-parameter limit.
const eventIdentityChunk = 50;

function safeJson(encoded: string): unknown {
    try {
        return JSON.parse(encoded);
    } catch {
        return null;
    }
}

function decodeJson<T>(encoded: string, decode: (value: unknown) => T): T {
    return decode(JSON.parse(encoded));
}

/** Persists the Turn history projection that the Session Recording folds from its batches. */
export class SessionTurnHistoryStorage {
    readonly #database;
    readonly #storage: DurableObjectStorage;
    constructor(storage: DurableObjectStorage, metrics: RecordingSqlMetrics = new RecordingSqlMetrics()) {
        applyDurableObjectMigrations(storage, sessionRecordingDurableObjectMigrations);
        this.#database = drizzle(storage, { schema, logger: metrics });
        this.#storage = storage;
    }

    /** Runs `operation` atomically; nested inside another transaction it rolls back on its own. */
    readonly transaction = <T>(operation: () => T): T => this.#storage.transactionSync(operation);

    /** Invalidates derived history atomically without changing any received event frames. */
    readonly resetProjection = (): void => {
        this.transaction(() => {
            this.#database.delete(recordedInteraction).run();
            this.#database.delete(recordedTurnItem).run();
            this.#database.delete(recordedTurn).run();
            this.#database.delete(recordingProjection).run();
            this.#database.delete(projectedSessionEvent).run();
        });
    };

    readonly projectedEvents = (events: readonly ProjectedEventIdentity[]): readonly ProjectedEventIdentity[] => {
        const stored: ProjectedEventIdentity[] = [];
        for (let index = 0; index < events.length; index += eventIdentityChunk) {
            stored.push(
                ...this.#database
                    .select()
                    .from(projectedSessionEvent)
                    .where(
                        or(
                            ...events
                                .slice(index, index + eventIdentityChunk)
                                .map((event) =>
                                    and(
                                        eq(projectedSessionEvent.generationId, event.generationId),
                                        eq(projectedSessionEvent.eventId, event.eventId),
                                    ),
                                ),
                        ),
                    )
                    .all(),
            );
        }
        return stored;
    };

    readonly projection = (): StoredProjection | null => {
        const row = this.#database
            .select()
            .from(recordingProjection)
            .where(eq(recordingProjection.singleton, 1))
            .all()[0];
        return row === undefined
            ? null
            : {
                  failure:
                      row.failureJson === null
                          ? null
                          : decodeJson(row.failureJson, (value) => storedProjectionFailureSchema.parse(value)),
                  foldedThroughOrdinal: row.foldedThroughOrdinal,
                  state: decodeJson(row.stateJson, (value) => storedProjectionStateSchema.parse(value)),
                  turnCount: row.turnCount,
              };
    };

    /** The recorded fold failure; reads only that column, so an undecodable projection state cannot hide it. */
    readonly failure = (): StoredProjectionFailure | null => {
        const row = this.#database
            .select({ failureJson: recordingProjection.failureJson })
            .from(recordingProjection)
            .where(eq(recordingProjection.singleton, 1))
            .all()[0];
        if (row === undefined || row.failureJson === null) {
            return null;
        }
        const parsed = storedProjectionFailureSchema.safeParse(safeJson(row.failureJson));
        return parsed.success ? parsed.data : null;
    };

    readonly failureAttempts = (): number => this.failure()?.attempts ?? 0;

    /** Records a fold failure without decoding or rewriting the rest of the projection. */
    readonly saveFailure = (failure: StoredProjectionFailure): void => {
        const failureJson = JSON.stringify(storedProjectionFailureSchema.parse(failure));
        this.#database
            .insert(recordingProjection)
            .values({
                failureJson,
                foldedThroughOrdinal: emptyProjection.foldedThroughOrdinal,
                singleton: 1,
                stateJson: JSON.stringify(emptyProjection.state),
                turnCount: emptyProjection.turnCount,
            })
            .onConflictDoUpdate({ target: recordingProjection.singleton, set: { failureJson } })
            .run();
    };

    /**
     * Commits one fold. Every record is validated and encoded before the first write, so a record
     * that does not fit its schema leaves the stored projection untouched.
     */
    readonly writeProjection = (writes: ProjectionWrites): void => {
        const projectionValues = {
            failureJson:
                writes.projection.failure === null
                    ? null
                    : JSON.stringify(storedProjectionFailureSchema.parse(writes.projection.failure)),
            foldedThroughOrdinal: writes.projection.foldedThroughOrdinal,
            singleton: 1,
            stateJson: JSON.stringify(storedProjectionStateSchema.parse(writes.projection.state)),
            turnCount: writes.projection.turnCount,
        };
        const turnRows = writes.turns.map(({ open, turn }) => ({
            commandId: turn.commandId,
            open,
            turnJson: JSON.stringify(storedTurnSchema.parse(turn)),
            turnOrder: turn.order,
        }));
        const itemRows = writes.items.map((write) => {
            const text = storedText(write.text.text);
            return {
                appended: write.text.kind === "append" ? appendedText(write.text.text) : null,
                values: {
                    commandId: write.commandId,
                    droppedCharacters: characterCount(write.text.text.slice(text.length)),
                    itemId: write.item.itemId,
                    itemJson: JSON.stringify(storedTurnItemSchema.parse(write.item)),
                    // A listing only narrows the item validated above, so it is encoded without parsing it again.
                    listingJson: write.listing === null ? null : JSON.stringify(write.listing),
                    sequence: write.item.sequence,
                    text,
                },
            };
        });
        const interactionRows = writes.interactions.map((record) => ({
            commandId: record.interaction.commandId,
            interactionId: record.interaction.interactionId,
            requestJson: JSON.stringify(storedInteractionSchema.parse(record.interaction)),
            requestedAt: record.requestedAt,
            resolved: record.resolved,
        }));

        for (const values of turnRows) {
            this.#database
                .insert(recordedTurn)
                .values(values)
                .onConflictDoUpdate({ target: recordedTurn.commandId, set: values })
                .run();
        }
        for (const { appended, values } of itemRows) {
            this.#database
                .insert(recordedTurnItem)
                .values(values)
                .onConflictDoUpdate({
                    target: [recordedTurnItem.commandId, recordedTurnItem.itemId],
                    set: {
                        itemJson: values.itemJson,
                        listingJson: values.listingJson,
                        sequence: values.sequence,
                        ...(appended ?? { droppedCharacters: values.droppedCharacters, text: values.text }),
                    },
                })
                .run();
        }
        for (const values of interactionRows) {
            this.#database
                .insert(recordedInteraction)
                .values(values)
                .onConflictDoUpdate({ target: recordedInteraction.interactionId, set: values })
                .run();
        }
        for (let index = 0; index < writes.events.length; index += eventIdentityChunk) {
            this.#database
                .insert(projectedSessionEvent)
                .values(writes.events.slice(index, index + eventIdentityChunk))
                .run();
        }
        this.#database
            .insert(recordingProjection)
            .values(projectionValues)
            .onConflictDoUpdate({ target: recordingProjection.singleton, set: projectionValues })
            .run();
    };

    readonly turn = (commandId: string): StoredTurn | null => {
        const row = this.#database
            .select({ turnJson: recordedTurn.turnJson })
            .from(recordedTurn)
            .where(eq(recordedTurn.commandId, commandId))
            .all()[0];
        return row === undefined ? null : decodeTurn(row.turnJson);
    };

    readonly hasTurn = (commandId: string): boolean =>
        this.#database
            .select({ commandId: recordedTurn.commandId })
            .from(recordedTurn)
            .where(eq(recordedTurn.commandId, commandId))
            .limit(1)
            .all()[0] !== undefined;

    readonly openTurns = (): readonly StoredTurn[] =>
        this.#database
            .select({ turnJson: recordedTurn.turnJson })
            .from(recordedTurn)
            .where(eq(recordedTurn.open, true))
            .all()
            .map((row) => decodeTurn(row.turnJson));

    /** Reads Turns newest first, strictly older than `beforeOrder` when it is given. */
    readonly turnsBefore = (beforeOrder: number | null, limit: number): readonly StoredTurn[] =>
        this.#database
            .select({ turnJson: recordedTurn.turnJson })
            .from(recordedTurn)
            .where(beforeOrder === null ? undefined : lt(recordedTurn.turnOrder, beforeOrder))
            .orderBy(desc(recordedTurn.turnOrder))
            .limit(limit)
            .all()
            .map((row) => decodeTurn(row.turnJson));

    readonly hasTurnBefore = (order: number): boolean =>
        this.#database
            .select({ order: recordedTurn.turnOrder })
            .from(recordedTurn)
            .where(lt(recordedTurn.turnOrder, order))
            .limit(1)
            .all()[0] !== undefined;

    /** Reads an item's fields without its text, which folding only ever appends to. */
    readonly item = (commandId: string, itemId: string): StoredTurnItem | null => {
        const row = this.#database
            .select({ itemJson: recordedTurnItem.itemJson })
            .from(recordedTurnItem)
            .where(and(eq(recordedTurnItem.commandId, commandId), eq(recordedTurnItem.itemId, itemId)))
            .all()[0];
        return row === undefined ? null : decodeItem(row.itemJson);
    };

    /** Reads one item with at most `textCharacters` of its text. */
    readonly itemRead = (commandId: string, itemId: string, textCharacters: number): StoredTurnItemRead | null => {
        const row = this.#database
            .select(itemReadColumns(textCharacters))
            .from(recordedTurnItem)
            .where(and(eq(recordedTurnItem.commandId, commandId), eq(recordedTurnItem.itemId, itemId)))
            .all()[0];
        return row === undefined ? null : decodeItemRead(row);
    };

    /**
     * Reads a Turn's items in sequence order, strictly after `afterSequence` when it is given, with at
     * most `textCharacters` of each item's text so a page never loads a whole merged answer.
     */
    readonly itemReadsAfter = (
        commandId: string,
        afterSequence: number | null,
        limit: number,
        textCharacters: number,
    ): readonly StoredTurnItemRead[] =>
        this.#database
            .select(itemReadColumns(textCharacters))
            .from(recordedTurnItem)
            .where(
                and(
                    eq(recordedTurnItem.commandId, commandId),
                    afterSequence === null ? undefined : gt(recordedTurnItem.sequence, afterSequence),
                ),
            )
            .orderBy(asc(recordedTurnItem.sequence))
            .limit(limit)
            .all()
            .map(decodeItemRead);

    /**
     * Reads a Turn's items strictly before `beforeSequence`, newest first. A transcript shows a
     * Turn's conclusion first, so the items a page lists start from the end of its sequence and the
     * work that produced it is read back from there.
     */
    readonly itemsBefore = (
        commandId: string,
        beforeSequence: number | null,
        limit: number,
        textCharacters: number,
    ): readonly StoredTurnItemRead[] =>
        this.#database
            .select(itemReadColumns(textCharacters))
            .from(recordedTurnItem)
            .where(
                and(
                    eq(recordedTurnItem.commandId, commandId),
                    beforeSequence === null ? undefined : lt(recordedTurnItem.sequence, beforeSequence),
                ),
            )
            .orderBy(desc(recordedTurnItem.sequence))
            .limit(limit)
            .all()
            .map(decodeItemRead);

    readonly hasItemBefore = (commandId: string, sequence: number): boolean =>
        this.#database
            .select({ sequence: recordedTurnItem.sequence })
            .from(recordedTurnItem)
            .where(and(eq(recordedTurnItem.commandId, commandId), lt(recordedTurnItem.sequence, sequence)))
            .limit(1)
            .all()[0] !== undefined;

    /** The command of a Turn holding an item with this identifier, if any. */
    readonly itemOwner = (itemId: string): string | null =>
        this.#database
            .select({ commandId: recordedTurnItem.commandId })
            .from(recordedTurnItem)
            .where(eq(recordedTurnItem.itemId, itemId))
            .limit(1)
            .all()[0]?.commandId ?? null;

    readonly hasItemAfter = (commandId: string, sequence: number): boolean =>
        this.#database
            .select({ sequence: recordedTurnItem.sequence })
            .from(recordedTurnItem)
            .where(and(eq(recordedTurnItem.commandId, commandId), gt(recordedTurnItem.sequence, sequence)))
            .limit(1)
            .all()[0] !== undefined;

    readonly interaction = (interactionId: string): StoredInteractionRecord | null => {
        const row = this.#database
            .select({
                requestJson: recordedInteraction.requestJson,
                requestedAt: recordedInteraction.requestedAt,
                resolved: recordedInteraction.resolved,
            })
            .from(recordedInteraction)
            .where(eq(recordedInteraction.interactionId, interactionId))
            .all()[0];
        return row === undefined ? null : decodeInteractionRecord(row);
    };

    readonly unresolvedInteractionsOf = (commandIds: readonly string[]): readonly StoredInteractionRecord[] =>
        commandIds.length === 0
            ? []
            : this.#database
                  .select({
                      requestJson: recordedInteraction.requestJson,
                      requestedAt: recordedInteraction.requestedAt,
                      resolved: recordedInteraction.resolved,
                  })
                  .from(recordedInteraction)
                  .where(
                      and(
                          inArray(recordedInteraction.commandId, [...commandIds]),
                          eq(recordedInteraction.resolved, false),
                      ),
                  )
                  .all()
                  .map(decodeInteractionRecord);

    /** Unresolved requests, oldest first. */
    readonly pendingInteractions = (limit: number): readonly StoredInteractionRecord[] =>
        this.#database
            .select({
                requestJson: recordedInteraction.requestJson,
                requestedAt: recordedInteraction.requestedAt,
                resolved: recordedInteraction.resolved,
            })
            .from(recordedInteraction)
            .where(eq(recordedInteraction.resolved, false))
            .orderBy(asc(recordedInteraction.requestedAt), asc(recordedInteraction.interactionId))
            .limit(limit)
            .all()
            .map(decodeInteractionRecord);
}

/** The longest prefix of `text` whose UTF-8 encoding fits a stored item, ending on a whole character. */
function storedText(text: string): string {
    if (text.length * 3 <= storedTurnItemBytes) {
        return text;
    }
    const { read } = new TextEncoder().encodeInto(text, new Uint8Array(storedTurnItemBytes));
    return text.slice(0, read);
}

/** Characters as SQLite counts them in stored text: a surrogate pair is one character. */
function characterCount(text: string): number {
    let pairs = 0;
    for (let index = 0; index + 1 < text.length; index += 1) {
        const unit = text.charCodeAt(index);
        const next = text.charCodeAt(index + 1);
        if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
            pairs += 1;
            index += 1;
        }
    }
    return text.length - pairs;
}

/**
 * Appends in SQL, so a growing answer is never read back and rewritten per batch, while its stored text
 * has room for all of it. Once text does not fit, it and everything after it only count as dropped, so
 * the stored text never skips ahead of what it left out.
 */
function appendedText(text: string) {
    const fits = sql`${recordedTurnItem.droppedCharacters} = 0 AND length(CAST(${recordedTurnItem.text} AS BLOB)) + ${new TextEncoder().encode(text).byteLength} <= ${storedTurnItemBytes}`;
    return {
        droppedCharacters: sql`CASE WHEN ${fits} THEN ${recordedTurnItem.droppedCharacters} ELSE ${recordedTurnItem.droppedCharacters} + ${characterCount(text)} END`,
        text: sql`CASE WHEN ${fits} THEN ${recordedTurnItem.text} || ${text} ELSE ${recordedTurnItem.text} END`,
    };
}

function itemReadColumns(textCharacters: number) {
    return {
        droppedCharacters: recordedTurnItem.droppedCharacters,
        itemJson: recordedTurnItem.itemJson,
        listingJson: recordedTurnItem.listingJson,
        textLength: sql<number>`length(${recordedTurnItem.text})`,
        textPrefix: sql<string>`substr(${recordedTurnItem.text}, 1, ${textCharacters})`,
    };
}

function decodeItemRead(row: {
    readonly droppedCharacters: number;
    readonly itemJson: string;
    readonly listingJson: string | null;
    readonly textLength: number;
    readonly textPrefix: string;
}): StoredTurnItemRead {
    return {
        droppedCharacters: row.droppedCharacters,
        item: decodeItem(row.itemJson),
        listing: row.listingJson === null ? null : decodeItem(row.listingJson),
        textLength: row.textLength,
        textPrefix: row.textPrefix,
    };
}

function decodeTurn(encoded: string): StoredTurn {
    return decodeJson(encoded, (value) => storedTurnSchema.parse(value));
}

function decodeItem(encoded: string): StoredTurnItem {
    return decodeJson(encoded, (value) => storedTurnItemSchema.parse(value));
}

function decodeInteractionRecord(row: {
    readonly requestJson: string;
    readonly requestedAt: number;
    readonly resolved: boolean;
}): StoredInteractionRecord {
    return {
        interaction: decodeJson(row.requestJson, (value) => storedInteractionSchema.parse(value)),
        requestedAt: row.requestedAt,
        resolved: row.resolved,
    };
}
