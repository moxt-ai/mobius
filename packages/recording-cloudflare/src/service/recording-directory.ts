import {
    conversationTitleFromText,
    type SessionEventV2,
    type SessionRecordingStatus,
    type SessionRecordingSummary,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import type { RecordingDirectoryStorage } from "../storage/recording-directory-storage.ts";

const statusFromEvent = (event: SessionEventV2): SessionRecordingStatus | null => {
    if (event.type !== "lifecycle-metadata") {
        return null;
    }
    switch (event.payload.kind) {
        case "prompt.requested":
        case "prompt.started":
            return "running";
        case "prompt.completed":
            return "idle";
        case "prompt.failed":
        case "prompt.failed-before-start":
            return "failed";
        default:
            return null;
    }
};

export class RecordingDirectory {
    readonly #storage: RecordingDirectoryStorage;
    constructor(storage: RecordingDirectoryStorage) {
        this.#storage = storage;
    }
    readonly record = (write: SessionRecordingWrite): void => {
        for (const event of write.envelope.events) {
            const existing = this.#storage.find(event.sessionId);
            const status = statusFromEvent(event);
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
                    status: status ?? existing?.status ?? "idle",
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
                    status: status ?? existing.status,
                    title:
                        event.type === "acp" && event.payload.sessionUpdate === "session_info_update"
                            ? (event.payload.title ?? existing.title)
                            : existing.title,
                    updatedAt: event.recordedAt,
                };
            } else {
                continue;
            }
            this.#storage.save(
                {
                    ...summary,
                    updatedAt:
                        existing !== null && Date.parse(existing.updatedAt) > Date.parse(summary.updatedAt)
                            ? existing.updatedAt
                            : summary.updatedAt,
                },
                write.projectId,
                write.runtimeId,
            );
        }
    };
}
