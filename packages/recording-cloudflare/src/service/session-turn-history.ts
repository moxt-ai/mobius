import type {
    AcpSessionUpdate,
    LifecycleMetadata,
    SessionLiveEvent,
    SessionRecordingCompaction,
    SessionRecordingExecution,
    SessionRecordingTurn,
    SessionRecordingTurnAttempt,
    SessionRecordingTurnItem,
    SessionRecordingTurnItemDetail,
    SessionRecordingTurnItemPage,
    SessionRecordingTurnPage,
} from "@moxt-ai/mobius-sdk/protocol";
import {
    decodeSessionLiveEvent,
    ProtocolMessageError,
    promptCompletion,
    SESSION_RECORDING_TURN_COMPACTION_MAX_ELEMENTS,
    type SessionWireEvent,
    sessionRecordingTurnItemCursor,
} from "@moxt-ai/mobius-sdk/protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { recordedSessionTitle } from "../entity/session-title.ts";
import {
    characterCount,
    emptyProjection,
    executionInactivityMilliseconds,
    type ItemTextChange,
    type ProjectedEventIdentity,
    type ProjectionWrites,
    projectedEventKey,
    type StoredInteraction,
    type StoredInteractionRecord,
    type StoredProjection,
    type StoredProjectionState,
    type StoredTurn,
    type StoredTurnItem,
    type StoredTurnItemRead,
    storedTurnItemBytes,
    type TurnItemWrite,
} from "../entity/session-turn-history.ts";
import type { SessionRecordingStorage } from "../storage/session-recording-storage.ts";
import type { SessionTurnHistoryStorage } from "../storage/session-turn-history-storage.ts";

// Serialized characters one Turn or item page aims to stay under; the first entry is always listed.
const pageCharacterBudget = 2_000_000;
// Listed answer and thought text keep this prefix; a full item read returns the rest.
const listedTextCharacters = 100_000;
// A listed tool item larger than this omits its detail, then bounds its labels; a full item read returns it.
const listedToolCharacters = 32_768;
const listedToolLabelCharacters = 2_048;
const listedToolLocations = 20;
// A full item read returns at most this many code points. SQLite counts code points while the protocol
// bounds an item to 50M UTF-16 units, so half of it fits even when every character is astral.
const itemTextCharacters = 25_000_000;
const listedItemsPerTurn = 200;
// Rows a page reads per query, so the character budget stops loading as soon as it is spent.
const turnReadChunk = 10;
const itemReadChunk = 20;
const waitingInteractionLimit = 100;
const retiredGenerationLimit = 100;
const backfillRetryBaseMilliseconds = 1_000;
const backfillRetryMaxMilliseconds = 60 * 60 * 1_000;
const interactionLimit = 1_000;
const activeCommandLimit = 1_000;
/** Recorded events one backfill step folds, so a step stays within Durable Object CPU limits. */
export const backfillEventsPerStep = 5_000;

export interface RecordingTarget {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
}

export type TurnHistoryRead<T> =
    | { readonly kind: "ready"; readonly value: T }
    // The projection has not folded every recorded batch yet; a backfill step is due.
    | { readonly kind: "building" }
    // Folding the next batch failed; backfill retries it at `retryAt`.
    | { readonly kind: "failed"; readonly retryAt: Date; readonly retryAfterSeconds: number }
    | { readonly kind: "not_found" };

export type BackfillOutcome =
    | { readonly kind: "caught_up" }
    | { readonly kind: "behind" }
    | { readonly kind: "failed"; readonly retryAt: Date };

interface AttemptTiming {
    readonly attemptId?: string;
    readonly startedAt?: string;
}

function attemptTiming(attempt: SessionRecordingTurnAttempt): AttemptTiming {
    if (attempt.kind === "none") {
        return {};
    }
    return {
        ...(attempt.attemptId === undefined ? {} : { attemptId: attempt.attemptId }),
        ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
    };
}

function isTerminal(attempt: SessionRecordingTurnAttempt): boolean {
    switch (attempt.kind) {
        case "succeeded":
        case "cancelled":
        case "failed":
            return true;
        case "none":
        case "running":
        case "waiting_input":
        case "indeterminate":
            return false;
    }
}

/** An attempt that a Session generation change would leave without an outcome. */
function isInterruptible(attempt: SessionRecordingTurnAttempt): boolean {
    return attempt.kind === "running" || attempt.kind === "waiting_input";
}

// Schema decoding can reorder keys; key order alone does not advance a tool's work.
function canonicalValue(item: unknown): string {
    return JSON.stringify(item, (_key, value: unknown): unknown => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return value;
        }
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, Reflect.get(value, key)]),
        );
    });
}

function detailFingerprint(value: unknown): string {
    return bytesToHex(sha256(new TextEncoder().encode(canonicalValue(value))));
}

function observedAttempt(turn: StoredTurn, now: number): SessionRecordingTurnAttempt {
    const activity = turn.activity;
    if (
        turn.attempt.kind !== "running" ||
        activity === null ||
        (activity.kind === "active" && now <= activity.observedAt + executionInactivityMilliseconds)
    ) {
        return turn.attempt;
    }
    return {
        ...attemptTiming(turn.attempt),
        detectedAt: new Date(
            activity.kind === "inactive"
                ? activity.detectedAt
                : activity.observedAt + executionInactivityMilliseconds + 1,
        ).toISOString(),
        kind: "indeterminate",
        reason: "execution_inactive",
    };
}

/** Bounds a tool item for a page: oversized detail is omitted first, then oversized labels are cut. */
function boundedTool(item: Extract<StoredTurnItem, { readonly kind: "tool" }>): StoredTurnItem {
    const omitted: StoredTurnItem = { ...item, detail: { kind: "omitted" } };
    if (JSON.stringify(omitted).length <= listedToolCharacters) {
        return omitted;
    }
    return {
        ...omitted,
        locations: omitted.locations
            .slice(0, listedToolLocations)
            .map((location) => ({ ...location, path: location.path.slice(0, listedToolLabelCharacters) })),
        name: omitted.name?.slice(0, listedToolLabelCharacters) ?? null,
        title: omitted.title.slice(0, listedToolLabelCharacters),
    };
}

/**
 * The item a fold stores and the bounded tool item pages list for it. Text items are bounded where their
 * text is stored, so only a tool carries a listing. A tool whose merged fields do not fit a stored item
 * keeps only what a page lists, and reads report its detail as omitted, so one oversized call cannot
 * block every later Turn.
 */
function storedItem(item: StoredTurnItem): { readonly item: StoredTurnItem; readonly listing: StoredTurnItem | null } {
    if (item.kind !== "tool") {
        return { item, listing: null };
    }
    const encoded = JSON.stringify(item);
    if (encoded.length <= listedToolCharacters) {
        return { item, listing: null };
    }
    const fits =
        encoded.length * 3 <= storedTurnItemBytes ||
        new TextEncoder().encode(encoded).byteLength <= storedTurnItemBytes;
    return fits ? { item, listing: boundedTool(item) } : { item: boundedTool(item), listing: null };
}

/** The identity and timing of a recorded event, which every event a fold handles carries. */
type FoldedEvent = Pick<SessionLiveEvent, "eventId" | "recordedAt" | "sessionGenerationId">;

/** Answer or reasoning text a fold adds: readable text, or the size of a chunk this deployment cannot read. */
type TextChunk =
    | { readonly kind: "readable"; readonly text: string }
    | { readonly kind: "unreadable"; readonly characters: number; readonly length: number };

type FoldInput =
    | { readonly kind: "event"; readonly event: SessionLiveEvent }
    // An answer or reasoning chunk that fails its schema. Its text is never stored, but it still counts
    // toward its item, so the item reports the characters it misses instead of reading as complete.
    | {
          readonly kind: "unreadable_text";
          readonly event: SessionWireEvent;
          readonly item: "answer" | "thought";
          readonly messageId: string | null;
          readonly chunk: Extract<TextChunk, { readonly kind: "unreadable" }>;
      };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text chunk an unreadable event carries, when it is an answer or reasoning chunk with text. */
function unreadableText(event: SessionWireEvent): FoldInput | null {
    if (event.type !== "acp") {
        return null;
    }
    const payload: Readonly<Record<string, unknown>> = event.payload;
    const item =
        payload["sessionUpdate"] === "agent_message_chunk"
            ? "answer"
            : payload["sessionUpdate"] === "agent_thought_chunk"
              ? "thought"
              : null;
    const content = payload["content"];
    if (item === null || !isRecord(content) || content["type"] !== "text" || typeof content["text"] !== "string") {
        return null;
    }
    const text = content["text"];
    const messageId = payload["messageId"];
    return {
        chunk: { characters: characterCount(text), kind: "unreadable", length: text.length },
        event,
        item,
        kind: "unreadable_text",
        messageId: typeof messageId === "string" ? messageId : null,
    };
}

/**
 * The events of a batch this deployment can fold. One it has no schema for, such as an update kind from
 * a newer Runtime, is left out of Turn history rather than blocking every later Turn of the Session; the
 * raw Recording keeps it. An unreadable answer or reasoning chunk is folded as text its item is missing.
 */
function foldInputs(wireEvents: readonly SessionWireEvent[]): readonly FoldInput[] {
    const inputs: FoldInput[] = [];
    let unreadable = 0;
    for (const wireEvent of wireEvents) {
        try {
            inputs.push({ event: decodeSessionLiveEvent(wireEvent), kind: "event" });
        } catch (cause) {
            if (!(cause instanceof ProtocolMessageError)) {
                throw cause;
            }
            unreadable += 1;
            const text = unreadableText(wireEvent);
            if (text !== null) {
                inputs.push(text);
            }
        }
    }
    if (unreadable > 0) {
        console.warn("Recording Turn history could not read events", {
            code: "recording_event_unreadable",
            events: unreadable,
        });
    }
    return inputs;
}

/** Whether two Turns hold the same fields; nested values compare by identity, as folding replaces them. */
function sameTurn(left: StoredTurn, right: StoredTurn): boolean {
    const entries = Object.entries(left);
    return (
        entries.length === Object.keys(right).length &&
        entries.every(([key, value]) => Object.is(Reflect.get(right, key), value))
    );
}

interface CachedItem {
    readonly commandId: string;
    readonly item: StoredTurnItem;
    // Text this fold adds; a new item sets it, an existing item appends it in storage.
    readonly text: ItemTextChange;
}

/**
 * Folds Recording events into the stored projection. Reads go through an in-memory cache and every
 * write is collected, so one batch touches each Turn, item, and request once and commits them together.
 * Answer and thought text is never read back: folding only appends to it.
 */
class ProjectionFold {
    readonly #storage: SessionTurnHistoryStorage;
    readonly #turns = new Map<string, StoredTurn>();
    readonly #items = new Map<string, CachedItem>();
    readonly #interactions = new Map<string, StoredInteractionRecord>();
    readonly #dirtyTurns = new Set<string>();
    readonly #dirtyItems = new Set<string>();
    readonly #dirtyInteractions = new Set<string>();
    readonly #events = new Map<string, ProjectedEventIdentity>();
    #state: StoredProjectionState;
    #turnCount: number;
    #receivedAt = 0;

    constructor(storage: SessionTurnHistoryStorage, projection: StoredProjection) {
        this.#storage = storage;
        this.#state = projection.state;
        this.#turnCount = projection.turnCount;
    }

    readonly fold = (wireEvents: readonly SessionWireEvent[], receivedAt: number): void => {
        this.#receivedAt = receivedAt;
        const inputs = foldInputs(wireEvents);
        const identities = inputs.map(({ event }) => ({
            eventId: event.eventId,
            generationId: event.sessionGenerationId,
        }));
        const storedEvents = new Set(this.#storage.projectedEvents(identities).map(projectedEventKey));
        for (const input of inputs) {
            const event = input.event;
            if (this.#state.retiredGenerationIds.includes(event.sessionGenerationId)) {
                // A late batch of a replaced process; folding it would interrupt the current generation.
                continue;
            }
            const identity = { eventId: event.eventId, generationId: event.sessionGenerationId };
            const key = projectedEventKey(identity);
            if (storedEvents.has(key) || this.#events.has(key)) {
                // Raw Recording retains received frames, but an event contributes to the fold only once.
                continue;
            }
            this.#events.set(key, identity);
            const previous = this.#state.generationId;
            if (previous !== null && previous !== event.sessionGenerationId) {
                // A new generation is a restarted local Agent process: nothing of the old one stays active.
                this.#state = {
                    ...this.#state,
                    activeCommands: null,
                    retiredGenerationIds: [...this.#state.retiredGenerationIds, previous].slice(
                        -retiredGenerationLimit,
                    ),
                };
                this.#markInterruptedAttempts(event);
            }
            this.#state = { ...this.#state, generationId: event.sessionGenerationId };
            if (input.kind === "unreadable_text") {
                this.#foldUnreadableText(input);
            } else if (input.event.type === "lifecycle-metadata") {
                this.#foldLifecycle(input.event, input.event.payload);
            } else {
                this.#foldAcp(input.event, input.event.payload);
            }
        }
    };

    readonly markInactive = (now: number): void => {
        for (const turn of this.#storage.inactiveCandidates(now)) {
            if (
                turn.attempt.kind === "running" &&
                turn.activity?.kind === "active" &&
                now > turn.activity.observedAt + executionInactivityMilliseconds
            ) {
                this.#putTurn({
                    ...turn,
                    activity: {
                        kind: "inactive",
                        observedAt: turn.activity.observedAt,
                        detectedAt: turn.activity.observedAt + executionInactivityMilliseconds + 1,
                    },
                });
            }
        }
    };

    #progress(commandId: string): void {
        const turn = this.#turn(commandId);
        if (
            turn === null ||
            !isInterruptible(turn.attempt) ||
            (turn.activity !== null && turn.activity.observedAt > this.#receivedAt)
        ) {
            return;
        }
        this.#putTurn({ ...turn, activity: { kind: "active", observedAt: this.#receivedAt } });
    }

    readonly writes = (foldedThroughOrdinal: number): ProjectionWrites => {
        const turns = [...this.#dirtyTurns].flatMap((commandId) => {
            const turn = this.#turns.get(commandId);
            return turn === undefined ? [] : [{ open: isInterruptible(turn.attempt), turn }];
        });
        // Listings are derived once per committed item, not on every update the batch folds into it.
        const items = [...this.#dirtyItems].flatMap((key): TurnItemWrite[] => {
            const cached = this.#items.get(key);
            if (cached === undefined) {
                return [];
            }
            return [{ commandId: cached.commandId, ...storedItem(cached.item), text: cached.text }];
        });
        const interactions = [...this.#dirtyInteractions].flatMap((interactionId) => {
            const record = this.#interactions.get(interactionId);
            return record === undefined ? [] : [record];
        });
        return {
            events: [...this.#events.values()],
            interactions,
            items,
            projection: { failure: null, foldedThroughOrdinal, state: this.#state, turnCount: this.#turnCount },
            turns,
        };
    };

    #turn(commandId: string): StoredTurn | null {
        const cached = this.#turns.get(commandId);
        if (cached !== undefined) {
            return cached;
        }
        const stored = this.#storage.turn(commandId);
        if (stored !== null) {
            this.#turns.set(commandId, stored);
        }
        return stored;
    }

    #putTurn(turn: StoredTurn): StoredTurn {
        const current = this.#turns.get(turn.commandId);
        // Folding often restates a Turn unchanged, such as reasoning that keeps its answer closed. Only a
        // changed Turn is written, so a batch does not encode and rewrite its prompt for nothing.
        if (current !== undefined && sameTurn(current, turn)) {
            return current;
        }
        this.#turns.set(turn.commandId, turn);
        this.#dirtyTurns.add(turn.commandId);
        return turn;
    }

    #ensureTurn(commandId: string, event: FoldedEvent): StoredTurn {
        const existing = this.#turn(commandId);
        if (existing !== null) {
            return existing;
        }
        this.#turnCount += 1;
        return this.#putTurn({
            answerLength: 0,
            activity: null,
            attempt: { kind: "none" },
            commandId,
            compactions: [],
            createdAt: event.recordedAt,
            generationId: event.sessionGenerationId,
            itemCount: 0,
            messageId: null,
            nextSequence: 0,
            openAnswer: null,
            openThought: null,
            order: this.#turnCount,
            preceding: null,
            prompt: null,
        });
    }

    #item(commandId: string, itemId: string): CachedItem | null {
        const key = `${commandId}\0${itemId}`;
        const cached = this.#items.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const stored = this.#storage.item(commandId, itemId);
        if (stored === null) {
            return null;
        }
        const loaded: CachedItem = {
            commandId,
            item: stored,
            text: { droppedCharacters: 0, kind: "append", text: "" },
        };
        this.#items.set(key, loaded);
        return loaded;
    }

    #putItem(commandId: string, item: StoredTurnItem, text: ItemTextChange): void {
        const key = `${commandId}\0${item.itemId}`;
        this.#items.set(key, { commandId, item, text });
        this.#dirtyItems.add(key);
    }

    /** Starts a text item; its text is kept outside the stored item fields. */
    #createTextItem(
        commandId: string,
        kind: "answer" | "thought",
        itemId: string,
        sequence: number,
        chunk: TextChunk,
    ): void {
        this.#putItem(
            commandId,
            { itemId, kind, omittedCharacters: 0, sequence, text: "" },
            chunk.kind === "readable"
                ? { droppedCharacters: 0, kind: "set", text: chunk.text }
                : { droppedCharacters: chunk.characters, kind: "set", text: "" },
        );
    }

    /** Adds text in order; once a chunk is missing, later text only counts as missing so none skips ahead. */
    #appendText(cached: CachedItem, chunk: TextChunk): void {
        const change = cached.text;
        this.#putItem(
            cached.commandId,
            cached.item,
            chunk.kind === "readable" && change.droppedCharacters === 0
                ? { ...change, text: `${change.text}${chunk.text}` }
                : {
                      ...change,
                      droppedCharacters:
                          change.droppedCharacters +
                          (chunk.kind === "readable" ? characterCount(chunk.text) : chunk.characters),
                  },
        );
    }

    #interaction(interactionId: string): StoredInteractionRecord | null {
        const cached = this.#interactions.get(interactionId);
        if (cached !== undefined) {
            return cached;
        }
        const stored = this.#storage.interaction(interactionId);
        if (stored !== null) {
            this.#interactions.set(interactionId, stored);
        }
        return stored;
    }

    #putInteraction(record: StoredInteractionRecord): void {
        this.#interactions.set(record.interaction.interactionId, record);
        this.#dirtyInteractions.add(record.interaction.interactionId);
    }

    /** Unresolved requests of a Turn, oldest first, including the ones this fold changed. */
    #unresolvedInteractions(commandId: string): readonly StoredInteractionRecord[] {
        for (const record of this.#storage.unresolvedInteractionsOf([commandId])) {
            if (!this.#interactions.has(record.interaction.interactionId)) {
                this.#interactions.set(record.interaction.interactionId, record);
            }
        }
        return [...this.#interactions.values()]
            .filter((record) => record.interaction.commandId === commandId && !record.resolved)
            .sort(
                (left, right) =>
                    left.requestedAt - right.requestedAt ||
                    left.interaction.interactionId.localeCompare(right.interaction.interactionId),
            );
    }

    /** Closes every request of a Turn that can no longer consume an answer. */
    #closeInteractions(commandId: string): void {
        for (const record of this.#unresolvedInteractions(commandId)) {
            this.#putInteraction({ ...record, resolved: true });
        }
    }

    /**
     * The attempt state while a Turn has unresolved requests: it waits on the newest of them, and runs
     * again only once none is left, however many were requested.
     */
    #waitingAttempt(turn: StoredTurn): SessionRecordingTurnAttempt {
        const [first, ...rest] = this.#unresolvedInteractions(turn.commandId)
            .map((record) => record.interaction.interactionId)
            .slice(-waitingInteractionLimit);
        return first === undefined
            ? { ...attemptTiming(turn.attempt), kind: "running" }
            : { ...attemptTiming(turn.attempt), interactionIds: [first, ...rest], kind: "waiting_input" };
    }

    #markInterruptedAttempts(event: FoldedEvent): void {
        const candidates = new Map<string, StoredTurn>();
        for (const turn of this.#storage.openTurns()) {
            candidates.set(turn.commandId, turn);
        }
        for (const [commandId, turn] of this.#turns) {
            candidates.set(commandId, turn);
        }
        for (const turn of candidates.values()) {
            if (!isInterruptible(turn.attempt) || turn.generationId === event.sessionGenerationId) {
                continue;
            }
            this.#turns.set(turn.commandId, turn);
            this.#putTurn({
                ...turn,
                compactions: this.#settledCompactions(turn, "cancelled"),
                attempt: {
                    ...attemptTiming(turn.attempt),
                    detectedAt: event.recordedAt,
                    kind: "indeterminate",
                    reason: "session_generation_changed",
                },
            });
            this.#closeInteractions(turn.commandId);
        }
    }

    #pushActive(event: SessionLiveEvent, commandId: string): void {
        const active = this.#state.activeCommands;
        const commandIds = active?.generationId === event.sessionGenerationId ? active.commandIds : [];
        this.#state = {
            ...this.#state,
            activeCommands: {
                commandIds: [...commandIds.filter((candidate) => candidate !== commandId), commandId],
                generationId: event.sessionGenerationId,
            },
        };
    }

    #removeActive(event: SessionLiveEvent, commandId: string): void {
        const active = this.#state.activeCommands;
        if (active === null || active.generationId !== event.sessionGenerationId) {
            return;
        }
        const remaining = active.commandIds.filter((candidate) => candidate !== commandId);
        this.#state = {
            ...this.#state,
            activeCommands: remaining.length === 0 ? null : { ...active, commandIds: remaining },
        };
    }

    #foldLifecycle(event: SessionLiveEvent, payload: LifecycleMetadata): void {
        switch (payload.kind) {
            case "session.queue.changed":
                return;
            case "prompt.requested": {
                const turn = this.#ensureTurn(payload.commandId, event);
                const precedingCommandId = this.#state.activeCommands?.commandIds.at(-1);
                const preceding =
                    precedingCommandId === undefined || precedingCommandId === payload.commandId
                        ? null
                        : this.#turn(precedingCommandId);
                this.#putTurn({
                    ...turn,
                    preceding:
                        preceding === null
                            ? null
                            : { commandId: preceding.commandId, itemCount: preceding.nextSequence },
                    createdAt: event.recordedAt,
                    generationId: event.sessionGenerationId,
                    prompt: {
                        content: payload.content,
                        ...(payload.disposition === undefined ? {} : { disposition: payload.disposition }),
                        ...(payload.targetCommandId === undefined ? {} : { targetCommandId: payload.targetCommandId }),
                    },
                });
                return;
            }
            case "prompt.started": {
                const turn = this.#ensureTurn(payload.commandId, event);
                // Output of a new attempt never extends items of the attempt it replaces.
                this.#putTurn({
                    ...turn,
                    compactions:
                        attemptTiming(turn.attempt).attemptId === payload.attemptId
                            ? turn.compactions
                            : this.#settledCompactions(turn, "cancelled"),
                    attempt: { attemptId: payload.attemptId, kind: "running", startedAt: event.recordedAt },
                    generationId: event.sessionGenerationId,
                    openAnswer: null,
                    openThought: null,
                });
                this.#pushActive(event, payload.commandId);
                // A new attempt starts without waiting; requests of the attempt it replaces cannot be answered.
                this.#closeInteractions(payload.commandId);
                this.#progress(payload.commandId);
                return;
            }
            case "prompt.completed": {
                const turn = this.#ensureTurn(payload.commandId, event);
                if (isTerminal(turn.attempt)) {
                    // An attempt settles once. The Runtime replays a settled outcome for a retried command as a new
                    // event; the recorded outcome and its time remain the first ones.
                    return;
                }
                const timing = attemptTiming(turn.attempt);
                const cancelled = promptCompletion(payload).kind === "cancelled";
                this.#putTurn({
                    ...turn,
                    compactions: this.#settledCompactions(turn, "cancelled"),
                    attempt: cancelled
                        ? { ...timing, cancelledAt: event.recordedAt, kind: "cancelled" }
                        : {
                              ...timing,
                              completedAt: event.recordedAt,
                              kind: "succeeded",
                              stopReason: payload.stopReason,
                          },
                });
                this.#removeActive(event, payload.commandId);
                this.#closeInteractions(payload.commandId);
                return;
            }
            case "prompt.failed":
            case "prompt.failed-before-start": {
                const turn = this.#ensureTurn(payload.commandId, event);
                if (isTerminal(turn.attempt)) {
                    return;
                }
                const { startedAt } = attemptTiming(turn.attempt);
                this.#putTurn({
                    ...turn,
                    compactions: this.#settledCompactions(turn, "failed"),
                    attempt: {
                        ...(payload.kind === "prompt.failed" ? { attemptId: payload.attemptId } : {}),
                        ...(startedAt === undefined ? {} : { startedAt }),
                        code: payload.code,
                        failedAt: event.recordedAt,
                        kind: "failed",
                        message: payload.message,
                    },
                });
                this.#removeActive(event, payload.commandId);
                this.#closeInteractions(payload.commandId);
                return;
            }
            case "session.permission.requested":
                this.#requestInteraction(event, {
                    commandId: payload.event.commandId,
                    event: payload.event,
                    interactionId: payload.event.interactionId,
                    kind: "permission",
                });
                return;
            case "session.elicitation.requested":
                this.#requestInteraction(event, {
                    commandId: payload.event.commandId,
                    event: payload.event,
                    interactionId: payload.event.interactionId,
                    kind: "elicitation",
                });
                return;
            case "session.permission.resolved":
            case "session.elicitation.resolved":
                this.#resolveInteraction(payload.event.interactionId);
                return;
        }
    }

    #requestInteraction(event: SessionLiveEvent, interaction: StoredInteraction): void {
        // A repeated request event must not reopen a request that was already answered or closed.
        if (this.#interaction(interaction.interactionId)?.resolved === true) {
            return;
        }
        const turn = this.#ensureTurn(interaction.commandId, event);
        // A Turn that ended or lost its process cannot consume an answer, so its request is closed at once.
        const consumable = !isTerminal(turn.attempt) && turn.attempt.kind !== "indeterminate";
        this.#putInteraction({ interaction, requestedAt: Date.parse(event.recordedAt), resolved: !consumable });
        if (!consumable) {
            return;
        }
        this.#putTurn({ ...turn, attempt: this.#waitingAttempt(turn) });
        this.#progress(turn.commandId);
    }

    #resolveInteraction(interactionId: string): void {
        const record = this.#interaction(interactionId);
        // An already closed request no longer belongs to a waiting attempt.
        if (record === null || record.resolved) {
            return;
        }
        this.#putInteraction({ ...record, resolved: true });
        const turn = this.#turn(record.interaction.commandId);
        if (turn === null || turn.attempt.kind !== "waiting_input") {
            return;
        }
        this.#putTurn({ ...turn, attempt: this.#waitingAttempt(turn) });
        this.#progress(turn.commandId);
    }

    #foldAcp(event: SessionLiveEvent, update: AcpSessionUpdate): void {
        if (update.sessionUpdate === "session_info_update" && update.title != null) {
            const title = recordedSessionTitle(update.title);
            if (title.length > 0) {
                this.#state = { ...this.#state, title };
            }
        }
        // Agent output belongs to the innermost command running in the current generation.
        const commandId = this.#state.activeCommands?.commandIds.at(-1);
        if (commandId === undefined) {
            return;
        }
        switch (update.sessionUpdate) {
            case "compaction_update":
                this.#mergeCompaction(event, commandId, update);
                return;
            case "agent_message_chunk": {
                if (update.content.type === "text") {
                    this.#appendAnswer(event, commandId, update.messageId ?? null, {
                        kind: "readable",
                        text: update.content.text,
                    });
                } else {
                    this.#progress(commandId);
                }
                const turn = this.#ensureTurn(commandId, event);
                if (update.messageId !== undefined && update.messageId !== null) {
                    this.#putTurn({ ...turn, messageId: update.messageId });
                }
                return;
            }
            case "agent_thought_chunk":
                if (update.content.type === "text") {
                    this.#appendThought(event, commandId, update.messageId ?? null, {
                        kind: "readable",
                        text: update.content.text,
                    });
                } else {
                    this.#progress(commandId);
                }
                return;
            case "tool_call":
            case "tool_call_update":
                this.#mergeTool(event, commandId, update);
                return;
            default:
                return;
        }
    }

    #settledCompactions(turn: StoredTurn, status: "failed" | "cancelled"): readonly SessionRecordingCompaction[] {
        return turn.compactions.map((compaction) =>
            compaction.status === "in_progress" ? { ...compaction, status } : compaction,
        );
    }

    #mergeCompaction(
        event: FoldedEvent,
        commandId: string,
        update: Extract<AcpSessionUpdate, { readonly sessionUpdate: "compaction_update" }>,
    ): void {
        const status = update.status;
        if (status !== "in_progress" && status !== "completed" && status !== "failed" && status !== "cancelled") {
            return;
        }
        const turn = this.#ensureTurn(commandId, event);
        const previous = turn.compactions.find((compaction) => compaction.compactionId === update.compactionId);
        // A repeated start or late frame cannot reopen a settled compaction.
        if (previous !== undefined && previous.status !== "in_progress") {
            return;
        }
        const compaction: SessionRecordingCompaction = {
            compactionId: update.compactionId,
            sequence: previous?.sequence ?? turn.nextSequence,
            status,
        };
        this.#putTurn({
            ...turn,
            compactions: [
                ...turn.compactions
                    .filter((entry) => entry.compactionId !== update.compactionId)
                    .slice(-(SESSION_RECORDING_TURN_COMPACTION_MAX_ELEMENTS - 1)),
                compaction,
            ],
            nextSequence: turn.nextSequence + (previous === undefined ? 1 : 0),
            openAnswer: null,
            openThought: null,
        });
        if (previous?.status !== status) {
            this.#progress(commandId);
        }
    }

    /** Folds an answer or reasoning chunk this deployment cannot read into the item it belongs to. */
    #foldUnreadableText(input: Extract<FoldInput, { readonly kind: "unreadable_text" }>): void {
        // Agent output belongs to the innermost command running in the current generation.
        const commandId = this.#state.activeCommands?.commandIds.at(-1);
        if (commandId === undefined) {
            return;
        }
        if (input.item === "answer") {
            this.#appendAnswer(input.event, commandId, input.messageId, input.chunk);
        } else {
            this.#appendThought(input.event, commandId, input.messageId, input.chunk);
        }
    }

    #appendAnswer(event: FoldedEvent, commandId: string, messageId: string | null, chunk: TextChunk): void {
        const turn = this.#ensureTurn(commandId, event);
        const length = chunk.kind === "readable" ? chunk.text.length : chunk.length;
        if (length === 0) {
            return;
        }
        const open =
            turn.openAnswer !== null && turn.openAnswer.messageId === messageId
                ? this.#item(commandId, turn.openAnswer.itemId)
                : null;
        if (open !== null && open.item.kind === "answer") {
            this.#appendText(open, chunk);
            this.#putTurn({ ...turn, answerLength: turn.answerLength + length });
            this.#progress(commandId);
            return;
        }
        const itemId = `answer:${event.eventId}`;
        this.#createTextItem(commandId, "answer", itemId, turn.nextSequence, chunk);
        // Answer text interrupts reasoning, so later reasoning starts a new thought item.
        this.#putTurn({
            ...turn,
            answerLength: turn.answerLength + length,
            itemCount: turn.itemCount + 1,
            nextSequence: turn.nextSequence + 1,
            openAnswer: { itemId, messageId },
            openThought: null,
        });
        this.#progress(commandId);
    }

    #appendThought(event: FoldedEvent, commandId: string, messageId: string | null, chunk: TextChunk): void {
        if ((chunk.kind === "readable" ? chunk.text.length : chunk.length) === 0) {
            return;
        }
        const turn = this.#ensureTurn(commandId, event);
        const open =
            turn.openThought !== null && turn.openThought.messageId === messageId
                ? this.#item(commandId, turn.openThought.itemId)
                : null;
        // Reasoning interrupts the answer stream, so the next answer chunk opens a new item.
        if (open !== null && open.item.kind === "thought") {
            this.#appendText(open, chunk);
            this.#putTurn({ ...turn, openAnswer: null });
            this.#progress(commandId);
            return;
        }
        const itemId = `thought:${event.eventId}`;
        this.#createTextItem(commandId, "thought", itemId, turn.nextSequence, chunk);
        this.#putTurn({
            ...turn,
            itemCount: turn.itemCount + 1,
            nextSequence: turn.nextSequence + 1,
            openAnswer: null,
            openThought: { itemId, messageId },
        });
        this.#progress(commandId);
    }

    #mergeTool(
        event: SessionLiveEvent,
        commandId: string,
        update: Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>,
    ): void {
        const itemId = `tool:${update.toolCallId}`;
        const owner = update.sessionUpdate === "tool_call_update" ? this.#toolOwner(commandId, itemId) : commandId;
        const turn = this.#ensureTurn(owner, event);
        const stored = this.#item(owner, itemId);
        const previous = stored !== null && stored.item.kind === "tool" ? stored.item : null;
        // A tool stored without its detail cannot show complete detail again; later patches only update
        // its labels, so a read keeps reporting the detail as omitted.
        const omitted = previous !== null && previous.detail.kind === "omitted";
        const previousDetail = previous !== null && previous.detail.kind === "inline" ? previous.detail : null;
        const rawInput = update.rawInput === undefined ? previousDetail?.rawInput : update.rawInput;
        const rawOutput = update.rawOutput === undefined ? previousDetail?.rawOutput : update.rawOutput;
        const priorProgress = previous?.toolProgress;
        const toolProgress = {
            content:
                update.content == null
                    ? (priorProgress?.content ?? detailFingerprint(previousDetail?.content ?? []))
                    : detailFingerprint(update.content),
            rawInput:
                update.rawInput === undefined
                    ? (priorProgress?.rawInput ??
                      (previousDetail?.rawInput === undefined ? null : detailFingerprint(previousDetail.rawInput)))
                    : detailFingerprint(update.rawInput),
            rawOutput:
                update.rawOutput === undefined
                    ? (priorProgress?.rawOutput ??
                      (previousDetail?.rawOutput === undefined ? null : detailFingerprint(previousDetail.rawOutput)))
                    : detailFingerprint(update.rawOutput),
        };
        const { attemptId } = attemptTiming(turn.attempt);
        const next: StoredTurnItem = {
            toolProgress,
            ...(attemptId === undefined ? {} : { attemptId }),
            detail: omitted
                ? { kind: "omitted" }
                : {
                      content: update.content ?? previousDetail?.content ?? [],
                      kind: "inline",
                      ...(rawInput === undefined ? {} : { rawInput }),
                      ...(rawOutput === undefined ? {} : { rawOutput }),
                  },
            itemId,
            kind: "tool",
            locations: update.locations ?? previous?.locations ?? [],
            name: update.name ?? previous?.name ?? null,
            sequence: previous?.sequence ?? turn.nextSequence,
            status: update.status ?? previous?.status ?? "pending",
            title: update.title ?? previous?.title ?? "",
            toolCallId: update.toolCallId,
            toolKind: update.kind ?? previous?.toolKind ?? null,
        };
        this.#putItem(owner, next, stored === null ? { droppedCharacters: 0, kind: "set", text: "" } : stored.text);
        // Tool work interrupts both the answer stream and the current run of reasoning.
        this.#putTurn({
            ...turn,
            ...(previous === null ? { itemCount: turn.itemCount + 1, nextSequence: turn.nextSequence + 1 } : {}),
            openAnswer: null,
            openThought: null,
        });
        if (
            canonicalValue(previous === null ? null : { ...previous, detail: undefined }) !==
            canonicalValue({ ...next, detail: undefined })
        ) {
            this.#progress(owner);
        }
    }

    /**
     * The command whose Turn holds a tool call. An update keeps reporting into the Turn that started the
     * call while that Turn still runs, even after a nested command became innermost; otherwise it
     * belongs to the innermost command, so a reused tool call id never reaches into an ended Turn.
     */
    #toolOwner(commandId: string, itemId: string): string {
        if (this.#item(commandId, itemId) !== null) {
            return commandId;
        }
        const cached = [...this.#items.values()].find((candidate) => candidate.item.itemId === itemId);
        const owner = cached?.commandId ?? this.#storage.itemOwner(itemId);
        const turn = owner === null ? null : this.#turn(owner);
        return owner !== null && turn !== null && isInterruptible(turn.attempt) ? owner : commandId;
    }
}

/** The item a read returns: a text item with a bounded prefix of its text, or the tool as it was read. */
function listedItem(read: StoredTurnItemRead, textCharacters: number): SessionRecordingTurnItem {
    switch (read.item.kind) {
        case "answer":
        case "thought":
            return {
                ...read.item,
                omittedCharacters: Math.max(0, read.textLength - textCharacters) + read.droppedCharacters,
                text: read.textPrefix,
            };
        case "tool":
            return read.item;
    }
}

/**
 * The Turn history of one Session Recording. Batches are folded in append order, inside the
 * transaction that records them; Recordings written before the projection existed are folded by
 * bounded backfill steps, and reads wait for the projection to reach the recorded tail.
 */
export class SessionTurnHistory {
    readonly #recording: SessionRecordingStorage;
    readonly #history: SessionTurnHistoryStorage;

    constructor(recording: SessionRecordingStorage, history: SessionTurnHistoryStorage) {
        this.#recording = recording;
        this.#history = history;
    }

    #projection(): StoredProjection | null {
        const projection = this.#history.projection();
        if (
            projection !== null &&
            (projection.state.version === 1 ||
                projection.state.compactionVersion !== 1 ||
                projection.state.activityVersion !== 1 ||
                projection.state.toolProgressVersion !== 1 ||
                projection.state.settlementVersion !== 1)
        ) {
            // Older projections may contain repeated text, omit compactions and activity, or carry an attempt's
            // replayed outcome instead of its first one. Rebuild
            // only derived tables from the unchanged raw Recording, using the bounded backfill.
            this.#history.resetProjection();
            return null;
        }
        return projection;
    }

    /**
     * Folds a batch that was just appended, inside the transaction that records it. Returns false when
     * the batch is left for backfill: earlier batches are unfolded, an earlier fold failed, or this
     * fold failed. A failed fold rolls back on its own and never prevents the batch from recording.
     */
    readonly project = (ordinal: number, events: readonly SessionWireEvent[], receivedAt = Date.now()): boolean => {
        try {
            return this.#history.transaction(() => {
                const projection = this.#projection() ?? emptyProjection;
                // Ordinals only grow, so a projection folded through the previous ordinal has nothing between.
                const unfolded =
                    projection.foldedThroughOrdinal !== ordinal - 1 &&
                    this.#recording.hasBatchBetween(projection.foldedThroughOrdinal, ordinal);
                if (projection.failure !== null || unfolded) {
                    return false;
                }
                const fold = new ProjectionFold(this.#history, projection);
                fold.fold(events, receivedAt);
                this.#history.writeProjection(fold.writes(ordinal));
                return true;
            });
        } catch (cause) {
            console.error("Recording Turn history could not fold an appended batch", cause);
            return false;
        }
    };

    /**
     * Folds up to `eventBudget` unfolded events. A failure is recorded with the time of its next
     * attempt, which backs off exponentially, so reads can report it instead of waiting indefinitely.
     */
    readonly backfill = (now: Date, eventBudget = backfillEventsPerStep): BackfillOutcome => {
        try {
            return this.#history.transaction((): BackfillOutcome => {
                const projection = this.#projection() ?? emptyProjection;
                const fold = new ProjectionFold(this.#history, projection);
                let foldedThrough = projection.foldedThroughOrdinal;
                let folded = 0;
                for (const batch of this.#recording.batchesAfter(foldedThrough)) {
                    if (folded >= eventBudget) {
                        break;
                    }
                    fold.fold(batch.events, batch.receivedAt);
                    foldedThrough = batch.ordinal;
                    folded += batch.events.length;
                }
                this.#history.writeProjection(fold.writes(foldedThrough));
                return foldedThrough >= this.#recording.latestOrdinal() ? { kind: "caught_up" } : { kind: "behind" };
            });
        } catch (cause) {
            console.error("Recording Turn history backfill failed", cause);
            // The failure may come from the projection row itself, so it is recorded without decoding it.
            const attempts = this.#history.failureAttempts() + 1;
            const delay = Math.min(backfillRetryBaseMilliseconds * 2 ** (attempts - 1), backfillRetryMaxMilliseconds);
            const retryAt = new Date(now.getTime() + delay);
            this.#history.saveFailure({
                attempts,
                code: "projection_fold_failed",
                failedAt: now.toISOString(),
                retryAt: retryAt.toISOString(),
            });
            return { kind: "failed", retryAt };
        }
    };

    readonly nextInactivityDeadline = (): number | null => this.#history.nextInactivityDeadline();

    readonly assessInactivity = (now: Date): boolean =>
        this.#history.transaction(() => {
            const projection = this.#projection();
            if (
                projection === null ||
                projection.failure !== null ||
                projection.foldedThroughOrdinal < this.#recording.latestOrdinal()
            ) {
                return false;
            }
            const fold = new ProjectionFold(this.#history, projection);
            fold.markInactive(now.getTime());
            const writes = fold.writes(projection.foldedThroughOrdinal);
            if (writes.turns.length === 0) {
                return false;
            }
            this.#history.writeProjection(writes);
            return true;
        });

    #activeCommands(state: StoredProjectionState): SessionRecordingExecution["activeCommands"] {
        const active = state.activeCommands;
        if (active === null) {
            return null;
        }
        const commandIds = this.#history
            .progressingCommandIds(active.commandIds, Date.now())
            .slice(-activeCommandLimit);
        return commandIds.length === 0 ? null : { commandIds, generationId: active.generationId };
    }

    readonly execution = (
        target: RecordingTarget,
        commandIds: readonly string[],
    ): TurnHistoryRead<SessionRecordingExecution> => {
        const readable = this.#readable(target);
        if (readable.kind !== "ready") {
            return readable;
        }
        const commands: SessionRecordingExecution["commands"][number][] = [];
        for (const commandId of new Set(commandIds)) {
            const turn = this.#history.turn(commandId);
            if (turn !== null) {
                commands.push({
                    attempt: observedAttempt(turn, Date.now()),
                    commandId,
                    generationId: turn.generationId,
                });
            }
        }
        return {
            kind: "ready",
            value: {
                activeCommands: this.#activeCommands(readable.value),
                commands,
                sessionId: target.sessionId,
                tailCursor: this.#recording.tailCursor(),
                version: 1,
            },
        };
    };

    readonly turnPage = (
        target: RecordingTarget,
        beforeOrder: number | null,
        limit: number,
    ): TurnHistoryRead<SessionRecordingTurnPage> => {
        const readable = this.#readable(target);
        if (readable.kind !== "ready") {
            return readable;
        }
        const state = readable.value;
        const turns: SessionRecordingTurn[] = [];
        let budget = pageCharacterBudget;
        let cursor = beforeOrder;
        // Turns load in small chunks and each one is listed only if it fits the remaining budget, so a
        // page reads little beyond what it lists; the first Turn is always listed so paging never stalls.
        reading: while (turns.length < limit) {
            const chunk = this.#history.turnsBefore(cursor, Math.min(turnReadChunk, limit - turns.length));
            for (const turn of chunk) {
                // Only the first Turn may exceed the budget; any later Turn must fit with its first item.
                const first = turns.length === 0;
                const promptSize = JSON.stringify(turn.prompt).length + JSON.stringify(turn.compactions).length;
                if (!first && promptSize >= budget) {
                    break reading;
                }
                // A page starts from the end of each Turn, so the work a page leaves out is the
                // work that produced the conclusion it does show.
                const listed = this.#listItems(
                    turn.commandId,
                    null,
                    "backward",
                    listedItemsPerTurn,
                    budget - promptSize,
                    first,
                );
                if (!first && listed.items.length === 0 && turn.itemCount > 0) {
                    break reading;
                }
                budget = listed.remaining;
                turns.push({
                    answerLength: turn.answerLength,
                    attempt: observedAttempt(turn, Date.now()),
                    commandId: turn.commandId,
                    compactions: turn.compactions,
                    createdAt: turn.createdAt,
                    generationId: turn.generationId,
                    itemCount: turn.itemCount,
                    items: listed.items,
                    itemsCursor: listed.cursor,
                    messageId: turn.messageId,
                    order: turn.order,
                    preceding: turn.preceding,
                    prompt: turn.prompt,
                });
                cursor = turn.order;
            }
            if (chunk.length < turnReadChunk) {
                break;
            }
        }
        const last = turns.at(-1);
        return {
            kind: "ready",
            value: {
                activeCommands: this.#activeCommands(state),
                interactions: this.#history.pendingInteractions(interactionLimit).map((record) => record.interaction),
                nextCursor: last !== undefined && this.#history.hasTurnBefore(last.order) ? `turn:${last.order}` : null,
                sessionId: target.sessionId,
                tailCursor: this.#recording.tailCursor(),
                title: state.title,
                turns,
                version: 1,
            },
        };
    };

    readonly itemPage = (
        target: RecordingTarget,
        commandId: string,
        from: { readonly afterSequence: number | null; readonly beforeSequence: number | null },
        limit: number,
    ): TurnHistoryRead<SessionRecordingTurnItemPage> => {
        const readable = this.#readable(target);
        if (readable.kind !== "ready") {
            return readable;
        }
        if (!this.#history.hasTurn(commandId)) {
            return { kind: "not_found" };
        }
        // One page reads one way: `before` reads back toward a Turn's earlier work, `after` forward
        // toward the work it is still producing. A caller that names neither gets the older one.
        const backward = from.beforeSequence !== null;
        const listed = this.#listItems(
            commandId,
            backward ? from.beforeSequence : from.afterSequence,
            backward ? "backward" : "forward",
            limit,
            pageCharacterBudget,
            true,
        );
        return {
            kind: "ready",
            value: {
                commandId,
                items: listed.items,
                nextCursor: listed.cursor,
                sessionId: target.sessionId,
                version: 1,
            },
        };
    };

    readonly item = (
        target: RecordingTarget,
        commandId: string,
        itemId: string,
    ): TurnHistoryRead<SessionRecordingTurnItemDetail> => {
        const readable = this.#readable(target);
        if (readable.kind !== "ready") {
            return readable;
        }
        const read = this.#history.itemRead(commandId, itemId, itemTextCharacters);
        if (read === null) {
            return { kind: "not_found" };
        }
        const item = listedItem(read, itemTextCharacters);
        return { kind: "ready", value: { commandId, item, sessionId: target.sessionId, version: 1 } };
    };

    /**
     * Lists a Turn's items from one end of its sequence until `limit` or the character budget is
     * reached. `forward` reads the oldest items first and `backward` the newest, which is what a
     * transcript wants: a Turn's conclusion is what a member sees first, and the work that produced
     * it fills in above as they read back. Items load in small chunks with bounded text. `admitFirst`
     * lists the first item of the run even over budget, so a page starting from one end of a Turn
     * never stalls.
     */
    #listItems(
        commandId: string,
        from: number | null,
        direction: "backward" | "forward",
        limit: number,
        budget: number,
        admitFirst: boolean,
    ): {
        readonly cursor: string | null;
        readonly items: readonly SessionRecordingTurnItem[];
        readonly remaining: number;
    } {
        const items: SessionRecordingTurnItem[] = [];
        let remaining = budget;
        let fromSequence = from;
        reading: while (items.length < limit) {
            const take = Math.min(itemReadChunk, limit - items.length);
            const chunk =
                direction === "forward"
                    ? this.#history.itemReadsAfter(commandId, fromSequence, take, listedTextCharacters)
                    : this.#history.itemsBefore(commandId, fromSequence, take, listedTextCharacters);
            for (const read of chunk) {
                const listed = listedItem(read, listedTextCharacters);
                // A listed tool encodes back to the JSON it was read from; text items carry their prefix too.
                const size = listed.kind === "tool" ? read.encodedLength : JSON.stringify(listed).length;
                if ((items.length > 0 || !admitFirst) && size > remaining) {
                    break reading;
                }
                items.push(listed);
                remaining -= size;
                fromSequence = listed.sequence;
            }
            if (chunk.length < itemReadChunk) {
                break;
            }
        }
        // A backward run collects newest first; a transcript lists items in the order they were made.
        const ordered = direction === "backward" ? [...items].reverse() : items;
        const edge = ordered.at(direction === "backward" ? 0 : -1);
        const more =
            edge !== undefined &&
            (direction === "backward"
                ? this.#history.hasItemBefore(commandId, edge.sequence)
                : this.#history.hasItemAfter(commandId, edge.sequence));
        return {
            cursor:
                more && edge !== undefined
                    ? sessionRecordingTurnItemCursor(direction === "backward" ? "before" : "after", edge.sequence)
                    : null,
            items: ordered,
            remaining,
        };
    }

    #readable(target: RecordingTarget): TurnHistoryRead<StoredProjectionState> {
        if (!this.#recording.records(target.projectId, target.runtimeId, target.sessionId)) {
            return { kind: "not_found" };
        }
        let projection: StoredProjection | null = null;
        try {
            projection = this.#projection();
        } catch (cause) {
            // An undecodable state is left to backfill, which records the failure that reads then report.
            console.error("Recording Turn history projection could not be read", cause);
        }
        const failure = this.#history.failure();
        if (failure !== null) {
            const delay = Date.parse(failure.retryAt) - Date.now();
            return {
                kind: "failed",
                retryAt: new Date(Date.parse(failure.retryAt)),
                retryAfterSeconds: Math.max(1, Math.ceil(delay / 1_000)),
            };
        }
        if (projection !== null && projection.foldedThroughOrdinal >= this.#recording.latestOrdinal()) {
            return { kind: "ready", value: projection.state };
        }
        return { kind: "building" };
    }
}
