import { AcpExecutionError } from "../../acp/acp-error.ts";

type Execution =
    | { readonly kind: "running"; readonly commandId: string }
    | { readonly kind: "cancelling"; readonly commandId: string; readonly completion: Promise<void> };

/**
 * The prompt executing in each Session. Cancellation names the command it stops and never outlives that command's
 * execution; a command cancelled before its execution begins is refused by its own turn instead.
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
        if (this.#entries.has(id)) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
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
