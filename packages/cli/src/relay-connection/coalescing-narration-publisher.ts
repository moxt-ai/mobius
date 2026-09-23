import type { DaemonScheduledTask, DaemonTimer } from "./timer.ts";

/** One streamed narration increment, already reduced to the text to append. */
export interface NarrationIncrement {
    readonly activityId: string;
    readonly activityType: string;
    readonly sequence: number;
    readonly text: string;
}

/**
 * Coalesces streaming narration increments into bounded, ordered events.
 *
 * Reasoning and progress activities are rewritten by the Agent once per streamed
 * chunk. Publishing each chunk as its own queued Session event both floods the
 * owning Attempt's replay window and, when the consumer folds the chunks into a
 * snapshot, makes the accumulated text grow quadratically. Buffering per activity
 * for a short window bounds the event rate while preserving text order: the
 * increments of one activity are sequential, so concatenating them reconstructs
 * exactly the narration the Agent produced.
 */
export class CoalescingNarrationPublisher {
    readonly #coalescingMilliseconds: number;
    readonly #maximumTextLength: number;
    readonly #publish: (increment: NarrationIncrement) => void;
    readonly #timer: DaemonTimer;
    readonly #pending = new Map<string, { activityType: string; sequence: number; text: string }>();
    #scheduled: DaemonScheduledTask | null = null;

    constructor(
        timer: DaemonTimer,
        publish: (increment: NarrationIncrement) => void,
        coalescingMilliseconds: number,
        maximumTextLength: number,
    ) {
        this.#publish = publish;
        this.#timer = timer;
        this.#coalescingMilliseconds = coalescingMilliseconds;
        this.#maximumTextLength = maximumTextLength;
    }

    /** Emit every buffered increment now, cancelling the pending flush. */
    readonly flush = (): void => {
        this.#scheduled?.cancel();
        this.#scheduled = null;
        const increments = [...this.#pending.entries()].map(
            ([activityId, pending]): NarrationIncrement => ({
                activityId,
                activityType: pending.activityType,
                sequence: pending.sequence,
                text: pending.text,
            }),
        );
        this.#pending.clear();
        for (const increment of increments) {
            this.#publish(increment);
        }
    };

    /**
     * Buffer an increment, emitting the buffered text when it would exceed the
     * protocol's per-event text limit so no event is rejected by the codec.
     */
    readonly record = (increment: NarrationIncrement): void => {
        if (increment.text.length === 0) {
            return;
        }
        const previous = this.#pending.get(increment.activityId);
        if (previous !== undefined && previous.text.length + increment.text.length > this.#maximumTextLength) {
            this.flush();
        }
        const current = this.#pending.get(increment.activityId);
        this.#pending.set(increment.activityId, {
            activityType: increment.activityType,
            sequence: increment.sequence,
            text: `${current?.text ?? ""}${increment.text}`,
        });
        this.#scheduled ??= this.#timer.schedule(this.flush, this.#coalescingMilliseconds);
    };
}
