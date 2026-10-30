import { conversationTitleFromText } from "@moxt-ai/mobius-sdk";
import { isSessionLiveEvent, type SessionWireEvent } from "@moxt-ai/mobius-sdk/protocol";
import type {
    DirectoryChange,
    DirectoryOperation,
    PendingDirectoryChange,
    RecordingDirectoryUpdate,
} from "../entity/recording-directory-update.ts";
import { recordedSessionTitle } from "../entity/session-title.ts";

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
        return { kind: "title", title: recordedSessionTitle(event.payload.title), recordedAt };
    }
    return { kind: "activity", recordedAt };
}

/** Appends an operation, folding consecutive activity into its latest time. */
function appendOperation(operations: DirectoryOperation[], next: DirectoryOperation): void {
    const previous = operations.at(-1);
    if (next.kind === "activity" && previous?.kind === "activity") {
        if (Date.parse(next.recordedAt) > Date.parse(previous.recordedAt)) {
            operations[operations.length - 1] = next;
        }
    } else {
        operations.push(next);
    }
}

/** Keeps a single Session's ordered creation/title changes while replacing other events with activity times. */
export function projectDirectoryChange(events: readonly SessionWireEvent[]): DirectoryChange {
    const operations: DirectoryOperation[] = [];
    for (const event of events) {
        appendOperation(operations, operation(event));
    }
    return { operations, events: events.length };
}

/** The directory accepts at most this many operations, and counts at most this many events, per update. */
const directoryUpdateBound = 1000;

/**
 * Joins a Session's oldest unconfirmed changes into one directory update, in commit order and within the
 * directory's bounds, with the last change it covers. Re-applying a prefix of the same changes leaves the directory
 * where applying them once does, so an update whose confirmation was lost is safe to send again.
 */
export function pendingDirectoryUpdate(
    identity: { readonly projectId: string; readonly runtimeId: string; readonly sessionId: string },
    pending: readonly PendingDirectoryChange[],
): { readonly update: RecordingDirectoryUpdate; readonly through: number } | null {
    const operations: DirectoryOperation[] = [];
    let events = 0;
    let through: number | null = null;
    for (const change of pending) {
        if (through !== null && operations.length + change.operations.length > directoryUpdateBound) {
            break;
        }
        for (const next of change.operations) {
            appendOperation(operations, next);
        }
        events += change.events;
        through = change.ordinal;
    }
    if (through === null) {
        return null;
    }
    return {
        update: {
            projectId: identity.projectId,
            runtimeId: identity.runtimeId,
            // The count only describes the update, so a larger backlog reports the bound.
            events: Math.min(Math.max(events, 1), directoryUpdateBound),
            updates: [{ sessionId: identity.sessionId, operations }],
        },
        through,
    };
}
