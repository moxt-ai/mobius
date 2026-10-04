import type * as p from "@moxt-ai/mobius-protocol";
import type { Session } from "./model.ts";

const PAGE_CHARACTERS = 200_000;

/** Select whole messages, advancing even when one oversized message must be disclosed as omitted. */
function select(messages: readonly p.ActiveTurnMessage[], end: number, limit: number) {
    let start = end;
    let characters = 0;
    let truncated = false;
    const selected: p.ActiveTurnMessage[] = [];
    while (start > 0 && selected.length < limit) {
        const message = messages[start - 1];
        if (message === undefined) {
            throw new Error("Invalid history boundary");
        }
        const size = JSON.stringify(message).length;
        if (size > PAGE_CHARACTERS) {
            start--;
            truncated = true;
            continue;
        }
        if (characters + size > PAGE_CHARACTERS) {
            break;
        }
        start--;
        characters += size;
        selected.unshift(message);
    }
    return { start, messages: selected, truncated };
}
function nativeMessage(message: p.ActiveTurnMessage): p.NativeHistoryMessage {
    if (message.role === "assistant") {
        return { role: "assistant", text: message.text, activities: message.activities, content: message.content };
    }
    return {
        role: "user",
        text: message.text,
        images: message.images?.flatMap((image) => {
            switch (image.mimeType) {
                case "image/png":
                case "image/jpeg":
                case "image/gif":
                case "image/webp":
                    return [{ ...image, mimeType: image.mimeType }];
                default:
                    throw new Error(`Unsupported fixture image: ${image.mimeType}`);
            }
        }),
    };
}
export function activeTurn(session: Session): p.ActiveTurnSnapshot | null {
    if (session.execution.kind === "idle") {
        return null;
    }
    const turn = session.execution.turn;
    const commandId = turn.commandIds[0];
    const page = select(turn.messages, turn.messages.length, 100);
    return {
        commandId,
        epoch: turn.epoch,
        hasOlder: page.start > 0,
        interaction: null,
        messages: page.messages,
        sequence: turn.sequence,
        state: "running",
        truncated: page.truncated,
    };
}
export function historyPage(session: Session, cursor: string | null, limit: number): p.NativeMessagePage {
    const turns = [...session.history, ...(session.execution.kind === "running" ? [session.execution.turn] : [])];
    const messages = turns.flatMap((turn) => turn.messages);
    const end = cursor === null ? messages.length : Number(cursor);
    if (!Number.isSafeInteger(end) || end < 0 || end > messages.length) {
        throw new Error("Invalid fake history cursor");
    }
    const page = select(messages, end, limit);
    const coveredCommandIds: string[] = [];
    const coveredMessageIds: string[] = [];
    let offset = 0;
    for (const turn of turns) {
        const fullTurn = offset >= page.start && offset + turn.messages.length <= end;
        const active = session.execution.kind === "running" && session.execution.turn === turn;
        if (fullTurn && !active && !page.truncated) {
            coveredCommandIds.push(...turn.commandIds);
        }
        // When loading backwards, reaching an active turn's beginning joins its already-read later pages.
        if (!page.truncated && (fullTurn || (active && offset >= page.start && offset < end))) {
            coveredMessageIds.push(...turn.commandIds.flatMap((id) => [`${id}:user`, `${id}:agent`]));
        }
        offset += turn.messages.length;
    }
    return {
        status: "available",
        messages: page.messages.map(nativeMessage),
        nextCursor: page.start === 0 ? null : String(page.start),
        truncated: page.truncated,
        coveredCommandIds,
        coveredMessageIds,
    };
}
