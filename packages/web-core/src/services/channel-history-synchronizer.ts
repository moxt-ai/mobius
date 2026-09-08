import type { ChannelHistory } from "@/domain/channel";

const ACTIVITY_REFRESH_DELAY_MILLISECONDS = 150;
const ACTIVE_TURN_REFRESH_DELAY_MILLISECONDS = 1_000;

export interface ChannelHistorySynchronizerPort {
    readonly applyHistory: (history: ChannelHistory) => void;
    readonly hasActiveTurns: () => boolean;
    readonly readHistory: (signal: AbortSignal) => Promise<ChannelHistory>;
    readonly reportFailure: (error: unknown) => void;
}

export class ChannelHistorySynchronizer {
    readonly #port: ChannelHistorySynchronizerPort;
    #active = false;
    #fetching = false;
    #queued = false;
    #requestController = new AbortController();
    #timerDueAt = 0;
    #timerId = 0;

    constructor(port: ChannelHistorySynchronizerPort) {
        this.#port = port;
    }

    readonly start = (): void => {
        if (this.#active) {
            return;
        }
        this.#active = true;
        if (this.#port.hasActiveTurns()) {
            this.#schedule(ACTIVE_TURN_REFRESH_DELAY_MILLISECONDS);
        }
    };

    readonly notifyActivity = (): void => {
        if (!this.#active) {
            return;
        }
        this.#schedule(ACTIVITY_REFRESH_DELAY_MILLISECONDS);
    };

    readonly stop = (): void => {
        this.#active = false;
        this.#queued = false;
        this.#requestController.abort();
        if (this.#timerId !== 0) {
            globalThis.clearTimeout(this.#timerId);
            this.#timerId = 0;
            this.#timerDueAt = 0;
        }
    };

    readonly #schedule = (delayMilliseconds: number): void => {
        const dueAt = Date.now() + delayMilliseconds;
        if (this.#timerId !== 0 && this.#timerDueAt <= dueAt) {
            return;
        }
        if (this.#timerId !== 0) {
            globalThis.clearTimeout(this.#timerId);
        }
        this.#timerDueAt = dueAt;
        this.#timerId = Number(
            globalThis.setTimeout(() => {
                this.#timerId = 0;
                this.#timerDueAt = 0;
                void this.#refresh();
            }, delayMilliseconds),
        );
    };

    readonly #refresh = async (): Promise<void> => {
        if (!this.#active) {
            return;
        }
        if (this.#fetching) {
            this.#queued = true;
            return;
        }
        this.#fetching = true;
        this.#requestController = new AbortController();
        try {
            const history = await this.#port.readHistory(this.#requestController.signal);
            if (this.#active) {
                this.#port.applyHistory(history);
            }
        } catch (error) {
            if (this.#active) {
                this.#port.reportFailure(error);
            }
        } finally {
            this.#fetching = false;
            if (this.#active) {
                if (this.#queued) {
                    this.#queued = false;
                    this.#schedule(ACTIVITY_REFRESH_DELAY_MILLISECONDS);
                } else if (this.#port.hasActiveTurns()) {
                    this.#schedule(ACTIVE_TURN_REFRESH_DELAY_MILLISECONDS);
                }
            }
        }
    };
}
