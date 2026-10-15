import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import {
    type StoredInteraction,
    type StoredProjection,
    type StoredTurn,
    type StoredTurnItem,
    storedInteractionSchema,
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

    readonly transaction = <T>(operation: () => T): T => this.#storage.transactionSync(operation);

    readonly projection = (): StoredProjection | null => {
        const row = this.#database.select().from(recordingProjection).where(eq(recordingProjection.singleton, 1)).get();
        return row === undefined
            ? null
            : {
                  foldedThroughOrdinal: row.foldedThroughOrdinal,
                  state: decodeJson(row.stateJson, (value) => storedProjectionStateSchema.parse(value)),
                  turnCount: row.turnCount,
              };
    };

    readonly saveProjection = (projection: StoredProjection): void => {
        const values = {
            foldedThroughOrdinal: projection.foldedThroughOrdinal,
            singleton: 1,
            stateJson: JSON.stringify(storedProjectionStateSchema.parse(projection.state)),
            turnCount: projection.turnCount,
        };
        this.#database
            .insert(recordingProjection)
            .values(values)
            .onConflictDoUpdate({ target: recordingProjection.singleton, set: values })
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

    readonly saveTurn = (turn: StoredTurn, open: boolean): void => {
        const values = {
            commandId: turn.commandId,
            open,
            turnJson: JSON.stringify(storedTurnSchema.parse(turn)),
            turnOrder: turn.order,
        };
        this.#database
            .insert(recordedTurn)
            .values(values)
            .onConflictDoUpdate({ target: recordedTurn.commandId, set: values })
            .run();
    };

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

    readonly item = (commandId: string, itemId: string): StoredTurnItem | null => {
        const row = this.#database
            .select({ itemJson: recordedTurnItem.itemJson })
            .from(recordedTurnItem)
            .where(and(eq(recordedTurnItem.commandId, commandId), eq(recordedTurnItem.itemId, itemId)))
            .get();
        return row === undefined ? null : decodeItem(row.itemJson);
    };

    readonly saveItem = (commandId: string, item: StoredTurnItem): void => {
        const values = {
            commandId,
            itemId: item.itemId,
            itemJson: JSON.stringify(storedTurnItemSchema.parse(item)),
            sequence: item.sequence,
        };
        this.#database
            .insert(recordedTurnItem)
            .values(values)
            .onConflictDoUpdate({ target: [recordedTurnItem.commandId, recordedTurnItem.itemId], set: values })
            .run();
    };

    /** Reads a Turn's items in sequence order, strictly after `afterSequence` when it is given. */
    readonly itemsAfter = (commandId: string, afterSequence: number | null, limit: number): readonly StoredTurnItem[] =>
        this.#database
            .select({ itemJson: recordedTurnItem.itemJson })
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
            .map((row) => decodeItem(row.itemJson));

    readonly interaction = (
        interactionId: string,
    ): { readonly interaction: StoredInteraction; readonly resolved: boolean } | null => {
        const row = this.#database
            .select({ requestJson: recordedInteraction.requestJson, resolved: recordedInteraction.resolved })
            .from(recordedInteraction)
            .where(eq(recordedInteraction.interactionId, interactionId))
            .get();
        return row === undefined ? null : { interaction: decodeInteraction(row.requestJson), resolved: row.resolved };
    };

    readonly saveInteraction = (interaction: StoredInteraction, resolved: boolean): void => {
        const values = {
            commandId: interaction.commandId,
            interactionId: interaction.interactionId,
            requestJson: JSON.stringify(storedInteractionSchema.parse(interaction)),
            resolved,
        };
        this.#database
            .insert(recordedInteraction)
            .values(values)
            .onConflictDoUpdate({ target: recordedInteraction.interactionId, set: values })
            .run();
    };

    readonly unresolvedInteractions = (): readonly StoredInteraction[] =>
        this.#database
            .select({ requestJson: recordedInteraction.requestJson })
            .from(recordedInteraction)
            .where(eq(recordedInteraction.resolved, false))
            .all()
            .map((row) => decodeInteraction(row.requestJson));
}

function decodeTurn(encoded: string): StoredTurn {
    return decodeJson(encoded, (value) => storedTurnSchema.parse(value));
}

function decodeItem(encoded: string): StoredTurnItem {
    return decodeJson(encoded, (value) => storedTurnItemSchema.parse(value));
}

function decodeInteraction(encoded: string): StoredInteraction {
    return decodeJson(encoded, (value) => storedInteractionSchema.parse(value));
}
