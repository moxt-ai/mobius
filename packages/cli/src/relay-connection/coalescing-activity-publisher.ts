import type { AcpActivity } from "../acp/activity.ts";
import type { DaemonScheduledTask, DaemonTimer } from "./timer.ts";

export const AGENT_ACTIVITY_COALESCING_MILLISECONDS = 100;

export class CoalescingDaemonActivityPublisher {
    readonly #pending = new Map<string, AcpActivity>();
    readonly #publish: (activity: AcpActivity) => void;
    readonly #publishedActivityIds = new Set<string>();
    readonly #scheduled = new Map<string, DaemonScheduledTask>();
    readonly #timer: DaemonTimer;

    constructor(timer: DaemonTimer, publish: (activity: AcpActivity) => void) {
        this.#publish = publish;
        this.#timer = timer;
    }

    readonly flush = (): void => {
        const activities = [...this.#pending.values()].sort((left, right) => left.sequence - right.sequence);
        for (const task of this.#scheduled.values()) {
            task.cancel();
        }
        this.#pending.clear();
        this.#scheduled.clear();
        for (const activity of activities) {
            this.#publish(activity);
        }
    };

    readonly record = (activity: AcpActivity): Promise<void> => {
        if (activity.status !== "pending" && activity.status !== "running") {
            this.#discardPending(activity.activityId);
            this.#publishedActivityIds.add(activity.activityId);
            this.#publish(activity);
            return Promise.resolve();
        }
        if (!this.#publishedActivityIds.has(activity.activityId)) {
            this.#publishedActivityIds.add(activity.activityId);
            this.#publish(activity);
            return Promise.resolve();
        }
        this.#pending.set(activity.activityId, activity);
        if (!this.#scheduled.has(activity.activityId)) {
            this.#scheduled.set(
                activity.activityId,
                this.#timer.schedule(
                    () => this.#flushActivity(activity.activityId),
                    AGENT_ACTIVITY_COALESCING_MILLISECONDS,
                ),
            );
        }
        return Promise.resolve();
    };

    readonly #discardPending = (activityId: string): void => {
        this.#scheduled.get(activityId)?.cancel();
        this.#scheduled.delete(activityId);
        this.#pending.delete(activityId);
    };

    readonly #flushActivity = (activityId: string): void => {
        const activity = this.#pending.get(activityId);
        this.#discardPending(activityId);
        if (activity !== undefined) {
            this.#publish(activity);
        }
    };
}
