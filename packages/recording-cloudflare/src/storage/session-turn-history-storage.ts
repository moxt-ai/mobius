import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import {
    type ProjectionWrites,
    type StoredInteractionRecord,
    type StoredProjection,
    type StoredTurn,
    type StoredTurnItem,
    type StoredTurnItemRead,
    storedInteractionSchema,
    storedProjectionFailureSchema,
    storedProjectionStateSchema,
    storedTurnItemSchema,
    storedTurnSchema,
} from "../entity/session-turn-history.ts";
import { sessionRecordingDurableObjectMigrations } from "../generated/session-recording-do-migrations.ts";
import * as schema from "../schema/session-recording-do/index.ts";
import {
    recordedInteraction,
    recordedTurn,
    recordedTurnItem,
    recordingProjection,
} from "../schema/session-recording-do/index.ts";
import { applyDurableObjectMigrations } from "./durable-object-migrations.ts";

function decodeJson<T>(encoded: string, decode: (value: unknown) => T): T {
    return decode(JSON.parse(encoded));
}

/** Persists the Turn history projection that the Session Recording folds from its batches. */
export class SessionTurnHistoryStorage {
    readonly #database;
    readonly #storage: DurableObjectStorage;
    constructor(storage: DurableObjectStorage) {
        applyDurableObjectMigrations(storage, sessionRecordingDurableObjectMigrations);
        this.#database = drizzle(storage, { schema });
        this.#storage = storage;
    }

    /** Runs `operation` atomically; nested inside another transaction it rolls back on its own. */
    readonly transaction = <T>(operation: () => T): T => this.#storage.transactionSync(operation);

    readonly projection = (): StoredProjection | null => {
        const row = this.#database.select().from(recordingProjection).where(eq(recordingProjection.singleton, 1)).get();
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
        const itemRows = writes.items.map((write) => ({
            change: write.text,
            values: {
                commandId: write.commandId,
                itemId: write.item.itemId,
                itemJson: JSON.stringify(storedTurnItemSchema.parse(write.item)),
                listingJson: write.listing === null ? null : JSON.stringify(storedTurnItemSchema.parse(write.listing)),
                sequence: write.item.sequence,
                text: write.text.text,
            },
        }));
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
        for (const { change, values } of itemRows) {
            this.#database
                .insert(recordedTurnItem)
                .values(values)
                .onConflictDoUpdate({
                    target: [recordedTurnItem.commandId, recordedTurnItem.itemId],
                    set: {
                        itemJson: values.itemJson,
                        listingJson: values.listingJson,
                        sequence: values.sequence,
                        // Appending in SQL keeps a growing answer from being read back and rewritten per batch.
                        text: change.kind === "append" ? sql`${recordedTurnItem.text} || ${change.text}` : change.text,
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
            .get();
        return row === undefined ? null : decodeTurn(row.turnJson);
    };

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
            .get() !== undefined;

    /** Reads an item's fields without its text, which folding only ever appends to. */
    readonly item = (commandId: string, itemId: string): StoredTurnItem | null => {
        const row = this.#database
            .select({ itemJson: recordedTurnItem.itemJson })
            .from(recordedTurnItem)
            .where(and(eq(recordedTurnItem.commandId, commandId), eq(recordedTurnItem.itemId, itemId)))
            .get();
        return row === undefined ? null : decodeItem(row.itemJson);
    };

    /** Reads one item with at most `textCharacters` of its text. */
    readonly itemRead = (commandId: string, itemId: string, textCharacters: number): StoredTurnItemRead | null => {
        const row = this.#database
            .select(itemReadColumns(textCharacters))
            .from(recordedTurnItem)
            .where(and(eq(recordedTurnItem.commandId, commandId), eq(recordedTurnItem.itemId, itemId)))
            .get();
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

    readonly hasItemAfter = (commandId: string, sequence: number): boolean =>
        this.#database
            .select({ sequence: recordedTurnItem.sequence })
            .from(recordedTurnItem)
            .where(and(eq(recordedTurnItem.commandId, commandId), gt(recordedTurnItem.sequence, sequence)))
            .limit(1)
            .get() !== undefined;

    readonly interaction = (interactionId: string): StoredInteractionRecord | null => {
        const row = this.#database
            .select({
                requestJson: recordedInteraction.requestJson,
                requestedAt: recordedInteraction.requestedAt,
                resolved: recordedInteraction.resolved,
            })
            .from(recordedInteraction)
            .where(eq(recordedInteraction.interactionId, interactionId))
            .get();
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

function itemReadColumns(textCharacters: number) {
    return {
        itemJson: recordedTurnItem.itemJson,
        listingJson: recordedTurnItem.listingJson,
        textLength: sql<number>`length(${recordedTurnItem.text})`,
        textPrefix: sql<string>`substr(${recordedTurnItem.text}, 1, ${textCharacters})`,
    };
}

function decodeItemRead(row: {
    readonly itemJson: string;
    readonly listingJson: string | null;
    readonly textLength: number;
    readonly textPrefix: string;
}): StoredTurnItemRead {
    return {
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
