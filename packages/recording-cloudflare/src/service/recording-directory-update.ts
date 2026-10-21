import type { SessionLiveEvent, SessionRecordingWrite } from "@moxt-ai/mobius-sdk/protocol";
import type { DirectoryOperation, RecordingDirectoryUpdate } from "../entity/recording-directory-update.ts";

const CONVERSATION_TITLE_CHARACTER_LIMIT = 42;

function conversationTitleFromText(text: string): string {
    let compact = "";
    for (const line of text.split(/\r?\n/u)) {
        const candidate = line.replaceAll(/\s+/g, " ").trim();
        if (candidate.length === 0 || candidate.startsWith("```") || candidate.startsWith("~~~")) {
            continue;
        }
        const readable = candidate
            .replace(/^(?:>\s*)+/u, "")
            .replace(/^#{1,6}(?:\s+|$)/u, "")
            .replace(/^(?:[-*+]|\d+[.)])\s+/u, "")
            .trim();
        if (readable.length > 0) {
            compact = readable;
            break;
        }
    }
    if (compact.length === 0) {
        compact = text.replaceAll(/\s+/g, " ").trim();
    }
    const characters = Array.from(compact);
    if (characters.length <= CONVERSATION_TITLE_CHARACTER_LIMIT) {
        return compact;
    }
    return `${characters.slice(0, CONVERSATION_TITLE_CHARACTER_LIMIT - 1).join("")}…`;
}

function operation(event: SessionLiveEvent): DirectoryOperation {
    const recordedAt = event.recordedAt;
    if (event.type === "lifecycle-metadata") {
        const payload = event.payload;
        switch (payload.kind) {
            case "prompt.requested":
                return payload.context === undefined
                    ? { kind: "status", status: "running", recordedAt }
                    : {
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
            case "prompt.started":
                return { kind: "status", status: "running", recordedAt };
            case "prompt.completed":
                return { kind: "status", status: "idle", recordedAt };
            case "prompt.failed":
            case "prompt.failed-before-start":
                return { kind: "status", status: "failed", recordedAt };
        }
    }
    if (event.type === "acp" && event.payload.sessionUpdate === "session_info_update" && event.payload.title != null) {
        return { kind: "title", title: event.payload.title, recordedAt };
    }
    return { kind: "activity", recordedAt };
}

/** Keeps ordered creation/title/status changes while replacing output bodies with activity times. */
export function projectDirectoryUpdate(write: SessionRecordingWrite): RecordingDirectoryUpdate {
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
