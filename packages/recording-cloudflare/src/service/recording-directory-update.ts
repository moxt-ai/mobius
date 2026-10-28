import { conversationTitleFromText } from "@moxt-ai/mobius-sdk";
import {
    isSessionLiveEvent,
    type SessionRecordingWireWrite,
    type SessionWireEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import type { DirectoryOperation, RecordingDirectoryUpdate } from "../entity/recording-directory-update.ts";

function operation(wireEvent: SessionWireEvent): DirectoryOperation {
    const recordedAt = wireEvent.recordedAt;
    // Only a prompt request or a Session info update can change a summary. Every other event only marks
    // activity, so it is not validated against the full live schema just to be discarded.
    const summarized =
        (wireEvent.type === "lifecycle-metadata" && wireEvent.payload["kind"] === "prompt.requested") ||
        (wireEvent.type === "acp" && wireEvent.payload["sessionUpdate"] === "session_info_update");
    if (!summarized || !isSessionLiveEvent(wireEvent)) {
        return { kind: "activity", recordedAt };
    }
    const event = wireEvent;
    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.requested") {
        const payload = event.payload;
        if (payload.context !== undefined) {
            return {
                kind: "requested",
                context: payload.context,
                title: conversationTitleFromText(
                    payload.content
                        .filter((block) => block.type === "text")
                        .map((block) => block.text)
                        .join(""),
                ),
                recordedAt,
            };
        }
    }
    if (event.type === "acp" && event.payload.sessionUpdate === "session_info_update" && event.payload.title != null) {
        return { kind: "title", title: event.payload.title, recordedAt };
    }
    return { kind: "activity", recordedAt };
}

/** Keeps ordered creation/title changes while replacing other events with activity times. */
export function projectDirectoryUpdate(write: SessionRecordingWireWrite): RecordingDirectoryUpdate {
    const sessions = new Map<string, DirectoryOperation[]>();
    for (const event of write.envelope.events) {
        const operations = sessions.get(event.sessionId) ?? [];
        const next = operation(event);
        const previous = operations.at(-1);
        if (next.kind === "activity" && previous?.kind === "activity") {
            if (Date.parse(next.recordedAt) > Date.parse(previous.recordedAt)) {
                operations[operations.length - 1] = next;
            }
        } else {
            operations.push(next);
        }
        sessions.set(event.sessionId, operations);
    }
    return {
        projectId: write.projectId,
        runtimeId: write.runtimeId,
        events: write.envelope.events.length,
        updates: [...sessions].map(([sessionId, operations]) => ({ sessionId, operations })),
    };
}
