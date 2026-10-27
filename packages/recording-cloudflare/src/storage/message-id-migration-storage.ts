import { and, asc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { type MessageIdMigrationProgress, messageIdMigrationProgressSchema } from "../entity/message-id-migration.ts";
import {
    legacyMessageIdentity,
    messageIdMigration,
    recordedSessionEvent,
    recordingMetadata,
} from "../schema/session-recording-do/index.ts";

export class MessageIdMigrationStorage {
    readonly #database;
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
        this.#database = drizzle(storage);
    }

    readonly transaction = <T>(operation: () => T): T => this.#storage.transactionSync(operation);
    readonly hasRecording = (): boolean => this.#database.select().from(recordingMetadata).limit(1).all().length > 0;
    readonly progress = (): MessageIdMigrationProgress | null => {
        const row = this.#database.select().from(messageIdMigration).where(eq(messageIdMigration.singleton, 1)).get();
        if (row === undefined) {
            return null;
        }
        const value: unknown = JSON.parse(row.progressJson);
        return messageIdMigrationProgressSchema.parse(value);
    };
    readonly save = (progress: MessageIdMigrationProgress): void => {
        const progressJson = JSON.stringify(messageIdMigrationProgressSchema.parse(progress));
        this.#database
            .insert(messageIdMigration)
            .values({ singleton: 1, progressJson })
            .onConflictDoUpdate({ target: messageIdMigration.singleton, set: { progressJson } })
            .run();
    };
    readonly batches = (afterOrdinal: number) =>
        this.#database
            .select({ ordinal: recordedSessionEvent.ordinal, envelopeJson: recordedSessionEvent.envelopeJson })
            .from(recordedSessionEvent)
            .where(gt(recordedSessionEvent.ordinal, afterOrdinal))
            .orderBy(asc(recordedSessionEvent.ordinal))
            .limit(8)
            .all();
    readonly rewrite = (ordinal: number, envelopeJson: string): void => {
        this.#database
            .update(recordedSessionEvent)
            .set({ envelopeJson })
            .where(eq(recordedSessionEvent.ordinal, ordinal))
            .run();
    };
    readonly identity = (generationId: string, eventId: string): string | undefined =>
        this.#database
            .select({ messageId: legacyMessageIdentity.messageId })
            .from(legacyMessageIdentity)
            .where(
                and(eq(legacyMessageIdentity.generationId, generationId), eq(legacyMessageIdentity.eventId, eventId)),
            )
            .get()?.messageId;
    readonly identify = (generationId: string, eventId: string, messageId: string): void => {
        this.#database.insert(legacyMessageIdentity).values({ generationId, eventId, messageId }).run();
    };
}
