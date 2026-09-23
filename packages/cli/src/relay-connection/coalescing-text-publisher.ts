import type { DaemonScheduledTask, DaemonTimer } from "./timer.ts";

/**
 * Coalesces streaming assistant text into a bounded, ordered event stream.
 *
 * Token-level Agents (Claude Code enables `includePartialMessages`) emit one
 * update per streamed token, so a single final answer can arrive as hundreds or
 * thousands of chunks. Forwarding each chunk as its own queued Session event
 * floods the owning Attempt's replay window and stalls the turn's text behind
 * the relay round trip. Buffering the text and flushing on a short timer bounds
 * the event rate without splitting or reordering the answer.
 *
 * Chunks are buffered in a single slot rather than keyed by message id: the
 * deltas of one turn are sequential, and a per-id map would reorder text that
 * interleaves across ids when the slots flush.
 */
export class CoalescingTextPublisher {
    readonly #coalescingMilliseconds: number;
    readonly #maximumTextLength: number;
    readonly #publish: (messageId: string, text: string) => void;
    readonly #timer: DaemonTimer;
    #messageId = "";
    #scheduled: DaemonScheduledTask | null = null;
    #text = "";

    constructor(
        timer: DaemonTimer,
        publish: (messageId: string, text: string) => void,
        coalescingMilliseconds: number,
        maximumTextLength: number,
    ) {
        this.#publish = publish;
        this.#timer = timer;
        this.#coalescingMilliseconds = coalescingMilliseconds;
        this.#maximumTextLength = maximumTextLength;
    }

    /** Emit any buffered text now, cancelling the pending flush. */
    readonly flush = (): void => {
        this.#scheduled?.cancel();
        this.#scheduled = null;
        const messageId = this.#messageId;
        const text = this.#text;
        this.#messageId = "";
        this.#text = "";
        if (text.length > 0) {
            this.#publish(messageId, text);
        }
    };

    /**
     * Buffer a chunk, emitting the buffered text when the message changes or the
     * buffer would exceed the protocol's per-event text limit.
     */
    readonly record = (messageId: string, text: string): void => {
        if (text.length === 0) {
            return;
        }
        if (
            this.#text.length > 0 &&
            (this.#messageId !== messageId || this.#text.length + text.length > this.#maximumTextLength)
        ) {
            this.flush();
        }
        this.#messageId = messageId;
        this.#text = `${this.#text}${text}`;
        this.#scheduled ??= this.#timer.schedule(this.flush, this.#coalescingMilliseconds);
    };
}
