import { AcpExecutionError } from "./acp-error.ts";

type Execution =
    | { readonly kind: "running"; readonly commandId: string }
    | { readonly kind: "cancelling"; readonly commandId: string; readonly completion: Promise<void> }
    | { readonly kind: "cancelled-before-start"; readonly completion: Promise<void> };

const unreachable = (state: never): never => {
    throw new AcpExecutionError("Unexpected execution state", { cause: state });
};

/** Cancellation remains attached to its command until that command finishes. */
export class ActiveExecutions {
    readonly #entries = new Map<string, Execution>();
    readonly command = (id: string): string | undefined => {
        const state = this.#entries.get(id);
        switch (state?.kind) {
            case "running":
            case "cancelling":
                return state.commandId;
            case "cancelled-before-start":
            case undefined:
                return undefined;
            default:
                return unreachable(state);
        }
    };
    readonly cancellation = (id: string): Promise<void> | undefined => {
        const state = this.#entries.get(id);
        switch (state?.kind) {
            case "cancelling":
            case "cancelled-before-start":
                return state.completion;
            case "running":
            case undefined:
                return undefined;
            default:
                return unreachable(state);
        }
    };
    readonly isBusy = (id: string): boolean => this.#entries.has(id);
    readonly begin = (id: string, commandId: string): void => {
        const state = this.#entries.get(id);
        switch (state?.kind) {
            case "running":
            case "cancelling":
                throw new AcpExecutionError(
                    "Another prompt is already running in this conversation",
                    {},
                    "session_busy",
                );
            case "cancelled-before-start":
            case undefined:
                break;
            default:
                unreachable(state);
        }
        this.#entries.set(
            id,
            state?.kind === "cancelled-before-start"
                ? { kind: "cancelling", commandId, completion: state.completion }
                : { kind: "running", commandId },
        );
    };
    readonly cancel = (id: string, stop: () => Promise<void>): Promise<void> => {
        const state = this.#entries.get(id);
        switch (state?.kind) {
            case "cancelling":
            case "cancelled-before-start":
                return state.completion;
            case "running":
            case undefined:
                break;
            default:
                return unreachable(state);
        }
        const completion = Promise.withResolvers<void>();
        this.#entries.set(
            id,
            state?.kind === "running"
                ? { kind: "cancelling", commandId: state.commandId, completion: completion.promise }
                : { kind: "cancelled-before-start", completion: completion.promise },
        );
        void (async () => await stop())().then(completion.resolve, completion.reject);
        return completion.promise;
    };
    readonly finish = (id: string, commandId: string): void => {
        if (this.command(id) === commandId) {
            this.#entries.delete(id);
        }
    };
}
