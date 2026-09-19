/**
 * Unsent composer text is the one piece of a conversation the Relay never sees, so it lives only in this
 * browser. Persisting it per Session keeps a reload, an accidental navigation, or a tab crash from
 * discarding a prompt the user was still writing. The Session id keys the entry: a draft belongs to the
 * conversation it was typed in, and a New chat draft is keyed by the id that conversation keeps when it is
 * promoted to a real Session.
 */
const DRAFT_PREFIX = "mobius:composer-draft:";
const LATEST_DRAFT_KEY = "mobius:composer-draft-latest";
const MAXIMUM_DRAFTS = 128;
const MAXIMUM_DRAFT_LENGTH = 10_000;

function storageKey(sessionId: string): string {
    return `${DRAFT_PREFIX}${encodeURIComponent(sessionId)}`;
}

function draftStorage(): Storage | null {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

export function readComposerDraft(sessionId: string): string {
    if (sessionId.length === 0) {
        return "";
    }
    const storage = draftStorage();
    if (storage === null) {
        return "";
    }
    let stored: string | null;
    try {
        stored = storage.getItem(storageKey(sessionId));
    } catch {
        return "";
    }
    // A draft is untrusted input once it round-trips through storage, so anything that is not a string of
    // the size the composer itself enforces is treated as absent rather than restored.
    if (stored === null || stored.length === 0 || stored.length > MAXIMUM_DRAFT_LENGTH) {
        return "";
    }
    return stored;
}

export function saveComposerDraft(sessionId: string, draft: string): void {
    if (sessionId.length === 0) {
        return;
    }
    const storage = draftStorage();
    if (storage === null) {
        return;
    }
    try {
        if (draft.length === 0 || draft.length > MAXIMUM_DRAFT_LENGTH) {
            storage.removeItem(storageKey(sessionId));
            // Only the newest draft is offered to a New chat that has no Session yet, so clearing the
            // conversation that owned it must clear the pending handoff too.
            if (storage.getItem(LATEST_DRAFT_KEY) === sessionId) {
                storage.removeItem(LATEST_DRAFT_KEY);
            }
            return;
        }
        storage.setItem(storageKey(sessionId), draft);
        storage.setItem(LATEST_DRAFT_KEY, sessionId);
        pruneDrafts(storage);
    } catch {
        // A full or unavailable store must never break typing; the draft simply is not durable.
    }
}

/**
 * The draft of the conversation the user was last writing in. A New chat has no Session until its first
 * prompt is sent, so after a reload there is no conversation to match its stored draft to; the newest
 * draft is handed to the fresh conversation instead.
 */
export function readPendingComposerDraft(): string {
    const storage = draftStorage();
    if (storage === null) {
        return "";
    }
    let sessionId: string | null;
    try {
        sessionId = storage.getItem(LATEST_DRAFT_KEY);
    } catch {
        return "";
    }
    if (sessionId === null || sessionId.length === 0) {
        return "";
    }
    return readComposerDraft(sessionId);
}

/**
 * Bounds the store so abandoned conversations cannot grow it without limit. Keys are appended in write
 * order, so the oldest drafts are the ones dropped first, except the one a New chat would restore.
 */
function pruneDrafts(storage: Storage): void {
    const latest = storage.getItem(LATEST_DRAFT_KEY);
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(DRAFT_PREFIX) === true && key !== storageKey(latest ?? "")) {
            keys.push(key);
        }
    }
    for (const key of keys.slice(0, Math.max(0, keys.length - MAXIMUM_DRAFTS))) {
        storage.removeItem(key);
    }
}
