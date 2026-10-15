import type {
    AcpSessionUpdateV2,
    LifecycleMetadataV2,
    SessionLiveEventV2,
    SessionRecordingInteraction,
    SessionRecordingTurn,
    SessionRecordingTurnAttempt,
    SessionRecordingTurnItem,
    SessionRecordingTurnItemDetail,
    SessionRecordingTurnItemPage,
    SessionRecordingTurnPage,
} from "@moxt-ai/mobius-protocol";
import {
    emptyProjectionState,
    type StoredInteraction,
    type StoredProjection,
    type StoredProjectionState,
    type StoredTurn,
    type StoredTurnItem,
} from "../entity/session-turn-history.ts";
import type { SessionRecordingStorage } from "../storage/session-recording-storage.ts";
import type { SessionTurnHistoryStorage } from "../storage/session-turn-history-storage.ts";

// Serialized characters one Turn or item page aims to stay under; the first entry is always listed.
const pageCharacterBudget = 2_000_000;
// Listed answer and thought text keep this prefix; a full item read returns the rest.
const listedTextCharacters = 100_000;
// Listed tool detail larger than this is omitted; a full item read returns it.
const listedToolDetailCharacters = 32_768;
const listedItemsPerTurn = 200;
const titleCharacters = 1_000;
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
    | { readonly kind: "not_found" };

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

/**
 * Folds Recording events into the stored projection. Reads go through an in-memory cache and writes
 * are committed once, so one batch decodes and rewrites each touched Turn and item a single time.
 */
class ProjectionFold {
    readonly #storage: SessionTurnHistoryStorage;
    readonly #turns = new Map<string, StoredTurn>();
    readonly #items = new Map<string, { readonly commandId: string; readonly item: StoredTurnItem }>();
    readonly #dirtyTurns = new Set<string>();
    readonly #dirtyItems = new Set<string>();
    #state: StoredProjectionState;
    #turnCount: number;

    constructor(storage: SessionTurnHistoryStorage, projection: StoredProjection) {
        this.#storage = storage;
        this.#state = projection.state;
        this.#turnCount = projection.turnCount;
    }

    readonly fold = (events: readonly SessionLiveEventV2[]): void => {
        for (const event of events) {
            if (this.#state.generationId !== null && this.#state.generationId !== event.sessionGenerationId) {
                // A new generation is a restarted local Agent process: nothing of the old one stays active.
                this.#state = { ...this.#state, activeCommands: null };
                this.#markInterruptedAttempts(event);
            }
            this.#state = { ...this.#state, generationId: event.sessionGenerationId };
            if (event.type === "lifecycle-metadata") {
                this.#foldLifecycle(event, event.payload);
            } else {
                this.#foldAcp(event, event.payload);
            }
        }
    };

    readonly commit = (foldedThroughOrdinal: number): void => {
        for (const commandId of this.#dirtyTurns) {
            const turn = this.#turns.get(commandId);
            if (turn !== undefined) {
                this.#storage.saveTurn(turn, isInterruptible(turn.attempt));
            }
        }
        for (const key of this.#dirtyItems) {
            const entry = this.#items.get(key);
            if (entry !== undefined) {
                this.#storage.saveItem(entry.commandId, entry.item);
            }
        }
        this.#storage.saveProjection({ foldedThroughOrdinal, state: this.#state, turnCount: this.#turnCount });
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
        this.#turns.set(turn.commandId, turn);
        this.#dirtyTurns.add(turn.commandId);
        return turn;
    }

    #ensureTurn(commandId: string, event: SessionLiveEventV2): StoredTurn {
        const existing = this.#turn(commandId);
        if (existing !== null) {
            return existing;
        }
        this.#turnCount += 1;
        return this.#putTurn({
            answerLength: 0,
            attempt: { kind: "none" },
            commandId,
            createdAt: event.recordedAt,
            generationId: event.sessionGenerationId,
            itemCount: 0,
            messageId: null,
            nextSequence: 0,
            openAnswerItemId: null,
            order: this.#turnCount,
            prompt: null,
            thoughtSegment: 0,
        });
    }

    #item(commandId: string, itemId: string): StoredTurnItem | null {
        const key = `${commandId}\0${itemId}`;
        const cached = this.#items.get(key);
        if (cached !== undefined) {
            return cached.item;
        }
        const stored = this.#storage.item(commandId, itemId);
        if (stored !== null) {
            this.#items.set(key, { commandId, item: stored });
        }
        return stored;
    }

    #putItem(commandId: string, item: StoredTurnItem): void {
        const key = `${commandId}\0${item.itemId}`;
        this.#items.set(key, { commandId, item });
        this.#dirtyItems.add(key);
    }

    #markInterruptedAttempts(event: SessionLiveEventV2): void {
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
            this.#putTurn({
                ...turn,
                attempt: {
                    ...attemptTiming(turn.attempt),
                    detectedAt: event.recordedAt,
                    kind: "indeterminate",
                    reason: "session_generation_changed",
                },
            });
        }
    }

    #pushActive(event: SessionLiveEventV2, commandId: string): void {
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

    #removeActive(event: SessionLiveEventV2, commandId: string): void {
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

    #foldLifecycle(event: SessionLiveEventV2, payload: LifecycleMetadataV2): void {
        switch (payload.kind) {
            case "session.queue.changed":
                return;
            case "prompt.requested": {
                const turn = this.#ensureTurn(payload.commandId, event);
                this.#putTurn({
                    ...turn,
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
                this.#putTurn({
                    ...turn,
                    attempt: { attemptId: payload.attemptId, kind: "running", startedAt: event.recordedAt },
                    generationId: event.sessionGenerationId,
                });
                this.#pushActive(event, payload.commandId);
                return;
            }
            case "prompt.completed": {
                const turn = this.#ensureTurn(payload.commandId, event);
                const timing = attemptTiming(turn.attempt);
                const cancelled = payload.stopReason === "cancelled" || payload.stopReason === "canceled";
                this.#putTurn({
                    ...turn,
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
                return;
            }
            case "prompt.failed":
            case "prompt.failed-before-start": {
                const turn = this.#ensureTurn(payload.commandId, event);
                const { startedAt } = attemptTiming(turn.attempt);
                this.#putTurn({
                    ...turn,
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

    #requestInteraction(event: SessionLiveEventV2, interaction: StoredInteraction): void {
        this.#storage.saveInteraction(interaction, false);
        const turn = this.#ensureTurn(interaction.commandId, event);
        // A request recorded after its Turn ended cannot reopen it.
        if (isTerminal(turn.attempt)) {
            return;
        }
        this.#putTurn({
            ...turn,
            attempt: {
                ...attemptTiming(turn.attempt),
                interactionIds: [interaction.interactionId],
                kind: "waiting_input",
            },
        });
    }

    #resolveInteraction(interactionId: string): void {
        const stored = this.#storage.interaction(interactionId);
        if (stored === null) {
            return;
        }
        this.#storage.saveInteraction(stored.interaction, true);
        const turn = this.#turn(stored.interaction.commandId);
        if (turn === null || isTerminal(turn.attempt)) {
            return;
        }
        this.#putTurn({ ...turn, attempt: { ...attemptTiming(turn.attempt), kind: "running" } });
    }

    #foldAcp(event: SessionLiveEventV2, update: AcpSessionUpdateV2): void {
        if (update.sessionUpdate === "session_info_update") {
            const title = update.title?.trim();
            if (title !== undefined && title.length > 0) {
                this.#state = { ...this.#state, title: title.slice(0, titleCharacters) };
            }
        }
        // Agent output belongs to the innermost command running in the current generation.
        const commandId = this.#state.activeCommands?.commandIds.at(-1);
        if (commandId === undefined) {
            return;
        }
        switch (update.sessionUpdate) {
            case "agent_message_chunk": {
                if (update.content.type === "text") {
                    this.#appendAnswer(event, commandId, update.content.text);
                }
                const turn = this.#ensureTurn(commandId, event);
                if (update.messageId !== undefined && update.messageId !== null) {
                    this.#putTurn({ ...turn, messageId: update.messageId });
                }
                return;
            }
            case "agent_thought_chunk":
                if (update.content.type === "text") {
                    this.#appendThought(event, commandId, update.messageId ?? null, update.content.text);
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

    #appendAnswer(event: SessionLiveEventV2, commandId: string, text: string): void {
        const turn = this.#ensureTurn(commandId, event);
        const open = turn.openAnswerItemId === null ? null : this.#item(commandId, turn.openAnswerItemId);
        if (open !== null && open.kind === "answer") {
            this.#putItem(commandId, { ...open, text: `${open.text}${text}` });
            this.#putTurn({ ...turn, answerLength: turn.answerLength + text.length });
            return;
        }
        const itemId = `answer:${event.eventId}`;
        this.#putItem(commandId, { itemId, kind: "answer", omittedCharacters: 0, sequence: turn.nextSequence, text });
        this.#putTurn({
            ...turn,
            answerLength: turn.answerLength + text.length,
            itemCount: turn.itemCount + 1,
            nextSequence: turn.nextSequence + 1,
            openAnswerItemId: itemId,
            thoughtSegment: turn.thoughtSegment + 1,
        });
    }

    #appendThought(event: SessionLiveEventV2, commandId: string, messageId: string | null, text: string): void {
        const turn = this.#ensureTurn(commandId, event);
        const itemId = `thought:${messageId ?? "current"}:${turn.thoughtSegment}`;
        const previous = this.#item(commandId, itemId);
        // Reasoning interrupts the answer stream, so the next answer chunk opens a new item.
        if (previous !== null && previous.kind === "thought") {
            this.#putItem(commandId, { ...previous, text: `${previous.text}${text}` });
            this.#putTurn({ ...turn, openAnswerItemId: null });
            return;
        }
        this.#putItem(commandId, { itemId, kind: "thought", omittedCharacters: 0, sequence: turn.nextSequence, text });
        this.#putTurn({
            ...turn,
            itemCount: turn.itemCount + 1,
            nextSequence: turn.nextSequence + 1,
            openAnswerItemId: null,
        });
    }

    #mergeTool(
        event: SessionLiveEventV2,
        commandId: string,
        update: Extract<AcpSessionUpdateV2, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>,
    ): void {
        const turn = this.#ensureTurn(commandId, event);
        const itemId = `tool:${update.toolCallId}`;
        const stored = this.#item(commandId, itemId);
        const previous = stored !== null && stored.kind === "tool" ? stored : null;
        const previousDetail = previous !== null && previous.detail.kind === "inline" ? previous.detail : null;
        const rawInput = update.rawInput === undefined ? previousDetail?.rawInput : update.rawInput;
        const rawOutput = update.rawOutput === undefined ? previousDetail?.rawOutput : update.rawOutput;
        const { attemptId } = attemptTiming(turn.attempt);
        this.#putItem(commandId, {
            ...(attemptId === undefined ? {} : { attemptId }),
            detail: {
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
        });
        // Tool work interrupts both the answer stream and the current run of reasoning.
        this.#putTurn({
            ...turn,
            ...(previous === null ? { itemCount: turn.itemCount + 1, nextSequence: turn.nextSequence + 1 } : {}),
            openAnswerItemId: null,
            thoughtSegment: turn.thoughtSegment + 1,
        });
    }
}

/** Bounds an item for a page; full item reads return it unchanged. */
function listedItem(item: StoredTurnItem): SessionRecordingTurnItem {
    switch (item.kind) {
        case "answer":
        case "thought":
            return item.text.length <= listedTextCharacters
                ? item
                : {
                      ...item,
                      omittedCharacters: item.text.length - listedTextCharacters,
                      text: item.text.slice(0, listedTextCharacters),
                  };
        case "tool":
            return JSON.stringify(item.detail).length <= listedToolDetailCharacters
                ? item
                : { ...item, detail: { kind: "omitted" } };
    }
}

/** Lists items in order until `limit` or the character budget; `stored` holds one extra item when more exist. */
function listItems(
    stored: readonly StoredTurnItem[],
    limit: number,
    budget: number,
): { readonly items: readonly SessionRecordingTurnItem[]; readonly remaining: number; readonly cursor: string | null } {
    const items: SessionRecordingTurnItem[] = [];
    let remaining = budget;
    for (const item of stored.slice(0, limit)) {
        const listed = listedItem(item);
        const size = JSON.stringify(listed).length;
        if (items.length > 0 && size > remaining) {
            break;
        }
        items.push(listed);
        remaining -= size;
    }
    const last = items.at(-1);
    return {
        cursor: last !== undefined && items.length < stored.length ? `item:${last.sequence}` : null,
        items,
        remaining,
    };
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

    /**
     * Folds a batch that was just appended. Returns false when earlier batches are still unfolded,
     * so the caller schedules a backfill step instead of folding out of order.
     */
    readonly project = (ordinal: number, events: readonly SessionLiveEventV2[]): boolean => {
        const projection = this.#history.projection() ?? {
            foldedThroughOrdinal: 0,
            state: emptyProjectionState,
            turnCount: 0,
        };
        if (this.#recording.hasBatchBetween(projection.foldedThroughOrdinal, ordinal)) {
            return false;
        }
        const fold = new ProjectionFold(this.#history, projection);
        fold.fold(events);
        fold.commit(ordinal);
        return true;
    };

    /** Folds up to `eventBudget` unfolded events; returns true once the projection reaches the tail. */
    readonly backfill = (eventBudget = backfillEventsPerStep): boolean =>
        this.#history.transaction(() => {
            const projection = this.#history.projection() ?? {
                foldedThroughOrdinal: 0,
                state: emptyProjectionState,
                turnCount: 0,
            };
            const fold = new ProjectionFold(this.#history, projection);
            let foldedThrough = projection.foldedThroughOrdinal;
            let folded = 0;
            for (const batch of this.#recording.batchesAfter(foldedThrough)) {
                if (folded >= eventBudget) {
                    break;
                }
                fold.fold(batch.events);
                foldedThrough = batch.ordinal;
                folded += batch.events.length;
            }
            fold.commit(foldedThrough);
            return foldedThrough >= this.#recording.latestOrdinal();
        });

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
        const stored = this.#history.turnsBefore(beforeOrder, limit + 1);
        const turns: SessionRecordingTurn[] = [];
        let budget = pageCharacterBudget;
        for (const turn of stored.slice(0, limit)) {
            if (turns.length > 0 && budget <= 0) {
                break;
            }
            budget -= JSON.stringify(turn.prompt).length;
            const listed = listItems(
                this.#history.itemsAfter(turn.commandId, null, listedItemsPerTurn + 1),
                listedItemsPerTurn,
                budget,
            );
            budget = listed.remaining;
            turns.push({
                answerLength: turn.answerLength,
                attempt: turn.attempt,
                commandId: turn.commandId,
                createdAt: turn.createdAt,
                generationId: turn.generationId,
                itemCount: turn.itemCount,
                items: listed.items,
                itemsCursor: listed.cursor,
                messageId: turn.messageId,
                order: turn.order,
                prompt: turn.prompt,
            });
        }
        const last = turns.at(-1);
        const active = state.activeCommands;
        return {
            kind: "ready",
            value: {
                activeCommands:
                    active === null || active.commandIds.length === 0
                        ? null
                        : {
                              commandIds: active.commandIds.slice(-activeCommandLimit),
                              generationId: active.generationId,
                          },
                interactions: this.#pendingInteractions(),
                nextCursor: last !== undefined && turns.length < stored.length ? `turn:${last.order}` : null,
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
        afterSequence: number | null,
        limit: number,
    ): TurnHistoryRead<SessionRecordingTurnItemPage> => {
        const readable = this.#readable(target);
        if (readable.kind !== "ready") {
            return readable;
        }
        if (this.#history.turn(commandId) === null) {
            return { kind: "not_found" };
        }
        const listed = listItems(
            this.#history.itemsAfter(commandId, afterSequence, limit + 1),
            limit,
            pageCharacterBudget,
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
        const item = this.#history.item(commandId, itemId);
        return item === null
            ? { kind: "not_found" }
            : { kind: "ready", value: { commandId, item, sessionId: target.sessionId, version: 1 } };
    };

    #readable(target: RecordingTarget): TurnHistoryRead<StoredProjectionState> {
        if (!this.#recording.records(target.projectId, target.runtimeId, target.sessionId)) {
            return { kind: "not_found" };
        }
        const projection = this.#history.projection();
        if (projection === null || projection.foldedThroughOrdinal < this.#recording.latestOrdinal()) {
            return { kind: "building" };
        }
        return { kind: "ready", value: projection.state };
    }

    /** Requests that a Turn can still consume: its attempt has not ended and its process was not restarted. */
    #pendingInteractions(): readonly SessionRecordingInteraction[] {
        return this.#history
            .unresolvedInteractions()
            .filter((interaction) => {
                const turn = this.#history.turn(interaction.commandId);
                return turn !== null && !isTerminal(turn.attempt) && turn.attempt.kind !== "indeterminate";
            })
            .slice(0, interactionLimit);
    }
}
