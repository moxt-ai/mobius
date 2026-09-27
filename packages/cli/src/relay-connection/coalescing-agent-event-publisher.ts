import type { AcpActivity, AcpActivityNarration } from "../acp/activity.ts";
import type { DaemonScheduledTask, DaemonTimer } from "./timer.ts";

export const AGENT_EVENT_COALESCING_MILLISECONDS = 100;
export const AGENT_EVENT_TEXT_MAXIMUM_LENGTH = 100_000;

export type BufferedAgentEvent =
    | { readonly kind: "activity"; readonly activity: AcpActivity }
    | { readonly kind: "narration"; readonly increment: AcpActivityNarration }
    | { readonly kind: "text"; readonly messageId: string; readonly text: string };

/**
 * Coalesces the Agent callback stream without splitting it into independently
 * timed channels. Entries stay in callback order, and only compatible adjacent
 * entries are combined. Activity updates therefore cannot let later text pass
 * an earlier tool boundary, while repeated updates still avoid saturating the
 * Relay connection.
 */
export class CoalescingAgentEventPublisher {
    #entries: readonly BufferedAgentEvent[] = [];
    readonly #publish: (event: BufferedAgentEvent) => void;
    readonly #publishedActivityIds = new Set<string>();
    #scheduled: DaemonScheduledTask | null = null;
    readonly #timer: DaemonTimer;

    constructor(timer: DaemonTimer, publish: (event: BufferedAgentEvent) => void) {
        this.#publish = publish;
        this.#timer = timer;
    }

    readonly flush = (): void => {
        this.#scheduled?.cancel();
        this.#scheduled = null;
        const entries = this.#entries;
        this.#entries = [];
        for (const entry of entries) {
            this.#publish(entry);
        }
    };

    readonly recordActivity = (activity: AcpActivity): Promise<void> => {
        const latest = this.#entries.at(-1);
        this.#entries =
            latest?.kind === "activity" && latest.activity.activityId === activity.activityId
                ? [...this.#entries.slice(0, -1), { activity, kind: "activity" }]
                : [...this.#entries, { activity, kind: "activity" }];

        const first = !this.#publishedActivityIds.has(activity.activityId);
        this.#publishedActivityIds.add(activity.activityId);
        if (first || (activity.status !== "pending" && activity.status !== "running")) {
            this.flush();
        } else {
            this.schedule();
        }
        return Promise.resolve();
    };

    readonly recordNarration = (increment: AcpActivityNarration): Promise<void> => {
        if (increment.text.length === 0) {
            return Promise.resolve();
        }
        let remaining = increment.text;
        while (remaining.length > 0) {
            const latest = this.#entries.at(-1);
            if (latest?.kind === "narration" && latest.increment.activityId === increment.activityId) {
                const available = AGENT_EVENT_TEXT_MAXIMUM_LENGTH - latest.increment.text.length;
                if (available > 0) {
                    this.#entries = [
                        ...this.#entries.slice(0, -1),
                        {
                            increment: {
                                ...increment,
                                text: `${latest.increment.text}${remaining.slice(0, available)}`,
                            },
                            kind: "narration",
                        },
                    ];
                    remaining = remaining.slice(available);
                    continue;
                }
            }
            this.#entries = [
                ...this.#entries,
                {
                    increment: { ...increment, text: remaining.slice(0, AGENT_EVENT_TEXT_MAXIMUM_LENGTH) },
                    kind: "narration",
                },
            ];
            remaining = remaining.slice(AGENT_EVENT_TEXT_MAXIMUM_LENGTH);
        }
        this.schedule();
        return Promise.resolve();
    };

    readonly recordText = (text: string, messageId: string): Promise<void> => {
        if (text.length === 0) {
            return Promise.resolve();
        }
        let remaining = text;
        while (remaining.length > 0) {
            const latest = this.#entries.at(-1);
            if (latest?.kind === "text" && latest.messageId === messageId) {
                const available = AGENT_EVENT_TEXT_MAXIMUM_LENGTH - latest.text.length;
                if (available > 0) {
                    this.#entries = [
                        ...this.#entries.slice(0, -1),
                        { ...latest, text: `${latest.text}${remaining.slice(0, available)}` },
                    ];
                    remaining = remaining.slice(available);
                    continue;
                }
            }
            this.#entries = [
                ...this.#entries,
                {
                    kind: "text",
                    messageId,
                    text: remaining.slice(0, AGENT_EVENT_TEXT_MAXIMUM_LENGTH),
                },
            ];
            remaining = remaining.slice(AGENT_EVENT_TEXT_MAXIMUM_LENGTH);
        }
        this.schedule();
        return Promise.resolve();
    };

    private schedule(): void {
        this.#scheduled ??= this.#timer.schedule(this.flush, AGENT_EVENT_COALESCING_MILLISECONDS);
    }
}
