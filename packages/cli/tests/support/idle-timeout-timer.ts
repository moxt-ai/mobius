import { type ScheduledTask, systemTimer, type Timer } from "../../src/engine/util/timer.ts";

/** Advances long retention deadlines without expiring the real transport's heartbeats. */
export class IdleTimeoutTimer implements Timer {
    #now = 0;
    readonly #tasks = new Map<symbol, { readonly due: number; readonly callback: () => void }>();

    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        if (milliseconds < 60 * 60 * 1_000) {
            return systemTimer.schedule(callback, milliseconds);
        }
        const id = Symbol("retention deadline");
        this.#tasks.set(id, { due: this.#now + milliseconds, callback });
        return { cancel: () => this.#tasks.delete(id) };
    };

    readonly advance = (milliseconds: number): void => {
        this.#now += milliseconds;
        for (const [id, task] of [...this.#tasks]) {
            if (task.due <= this.#now && this.#tasks.delete(id)) {
                task.callback();
            }
        }
    };
}
