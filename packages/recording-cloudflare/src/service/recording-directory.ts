import type { SessionRecordingSummary, SessionRecordingWrite } from "@moxt-ai/mobius-sdk/protocol";
import type { RecordingDirectoryUpdate } from "../entity/recording-directory-update.ts";
import type { RecordingDirectoryStorage } from "../storage/recording-directory-storage.ts";
import { projectDirectoryUpdate } from "./recording-directory-update.ts";

export class RecordingDirectory {
    readonly #storage: RecordingDirectoryStorage;
    constructor(storage: RecordingDirectoryStorage) {
        this.#storage = storage;
    }
    readonly record = (write: SessionRecordingWrite): void => this.apply(projectDirectoryUpdate(write));
    readonly apply = (write: RecordingDirectoryUpdate): void => {
        for (const { sessionId, operations } of write.updates) {
            const initial = this.#storage.find(sessionId);
            let summary: SessionRecordingSummary | null = initial;
            for (const operation of operations) {
                const existing = summary;
                if (operation.kind === "requested") {
                    summary = {
                        ...operation.context,
                        sessionId,
                        runtimeId: write.runtimeId,
                        status: "running",
                        title: existing?.title || operation.title,
                        updatedAt: operation.recordedAt,
                    };
                } else if (existing !== null) {
                    summary = {
                        ...existing,
                        status: operation.kind === "status" ? operation.status : existing.status,
                        title: operation.kind === "title" ? operation.title : existing.title,
                        updatedAt: operation.recordedAt,
                    };
                }
                if (
                    summary !== null &&
                    existing !== null &&
                    Date.parse(existing.updatedAt) > Date.parse(summary.updatedAt)
                ) {
                    summary = { ...summary, updatedAt: existing.updatedAt };
                }
            }
            if (summary !== null && JSON.stringify(summary) !== JSON.stringify(initial)) {
                this.#storage.save(summary);
            }
        }
    };
}
