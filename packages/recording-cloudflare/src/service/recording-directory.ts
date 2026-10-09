import {
    conversationTitleFromText,
    type SessionRecordingSummary,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import type { RecordingDirectoryStorage } from "../storage/recording-directory-storage.ts";

export class RecordingDirectory {
    readonly #storage: RecordingDirectoryStorage;
    constructor(storage: RecordingDirectoryStorage) {
        this.#storage = storage;
    }
    readonly record = (write: SessionRecordingWrite): void => {
        for (const event of write.envelope.events) {
            const existing = this.#storage.find(event.sessionId);
            let summary: SessionRecordingSummary;
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.requested" &&
                event.payload.context !== undefined
            ) {
                const context = event.payload.context;
                summary = {
                    ...context,
                    runtimeId: write.runtimeId,
                    sessionId: event.sessionId,
                    title:
                        existing?.title ||
                        conversationTitleFromText(
                            event.payload.content
                                .filter((block) => block.type === "text")
                                .map((block) => block.text)
                                .join(""),
                        ),
                    updatedAt: event.recordedAt,
                };
            } else if (existing !== null) {
                summary = {
                    ...existing,
                    title:
                        event.type === "acp" && event.payload.sessionUpdate === "session_info_update"
                            ? (event.payload.title ?? existing.title)
                            : existing.title,
                    updatedAt: event.recordedAt,
                };
            } else {
                continue;
            }
            this.#storage.save({
                ...summary,
                updatedAt:
                    existing !== null && Date.parse(existing.updatedAt) > Date.parse(summary.updatedAt)
                        ? existing.updatedAt
                        : summary.updatedAt,
            });
        }
    };
}
