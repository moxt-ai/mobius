/** Runs asynchronous tasks in order without letting a failure block later tasks. */
export class SerialTaskQueue {
    #tail: Promise<unknown> = Promise.resolve();

    readonly run = async <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> => {
        signal.throwIfAborted();
        const result = this.#tail.then(() => {
            signal.throwIfAborted();
            return task(signal);
        });
        this.#tail = result.catch(() => undefined);
        return await result;
    };
}
