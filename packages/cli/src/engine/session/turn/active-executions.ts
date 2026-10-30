type Execution =
    | { readonly kind: "running"; readonly commandId: string }
    | { readonly kind: "cancelling"; readonly commandId: string; readonly completion: Promise<void> };

/**
 * The prompt each Session's Agent process is driving, and the cancellation sent to it. Session admission is the only
 * owner of whether a Session is busy and admits one execution at a time, so this records that execution without
 * deciding it again. Cancellation names the command it stops and never outlives that command's execution; a command
 * cancelled before its execution begins is withdrawn by its own turn instead.
 */
export class ActiveExecutions {
    readonly #entries = new Map<string, Execution>();
    readonly command = (id: string): string | undefined => this.#entries.get(id)?.commandId;
    readonly cancellation = (id: string): Promise<void> | undefined => {
        const state = this.#entries.get(id);
        return state?.kind === "cancelling" ? state.completion : undefined;
    };
    readonly isBusy = (id: string): boolean => this.#entries.has(id);
    readonly begin = (id: string, commandId: string): void => {
        this.#entries.set(id, { kind: "running", commandId });
    };
    readonly cancel = (id: string, commandId: string, stop: () => Promise<void>): Promise<void> => {
        const state = this.#entries.get(id);
        if (state?.commandId !== commandId) {
            return Promise.resolve();
        }
        if (state.kind === "cancelling") {
            return state.completion;
        }
        const completion = Promise.withResolvers<void>();
        this.#entries.set(id, { kind: "cancelling", commandId, completion: completion.promise });
        void (async () => await stop())().then(completion.resolve, completion.reject);
        return completion.promise;
    };
    readonly finish = (id: string, commandId: string): void => {
        if (this.command(id) === commandId) {
            this.#entries.delete(id);
        }
    };
}
