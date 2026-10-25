import type { ActiveRuntimeTurn } from "./active-turn.ts";

type UpgradeAdmission =
    | { readonly kind: "open" }
    | { readonly kind: "waiting"; readonly reserve: () => void }
    | { readonly kind: "reserved" };

/** Shared by every Runtime in a worker, including turns waiting for input or queue admission. */
export class RuntimeTurnActivity {
    readonly #turns = new Set<ActiveRuntimeTurn>();
    #admission: UpgradeAdmission = { kind: "open" };

    readonly acceptsPrompts = (): boolean => this.#admission.kind !== "reserved";

    readonly count = (): number => this.#turns.size;

    readonly start = (turn: ActiveRuntimeTurn): void => {
        this.#turns.add(turn);
    };

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#turns.delete(turn);
        if (this.#turns.size === 0 && this.#admission.kind === "waiting") {
            // Close admission synchronously with the last completion, before another prompt can start.
            this.#admission.reserve();
        }
    };

    readonly reserveWhenIdle = (signal: AbortSignal): Promise<Disposable> => {
        signal.throwIfAborted();
        if (this.#admission.kind !== "open") {
            throw new Error("A daemon upgrade already owns admission");
        }
        return new Promise<Disposable>((resolve, reject) => {
            const abort = (): void => {
                this.#admission = { kind: "open" };
                signal.removeEventListener("abort", abort);
                reject(signal.reason);
            };
            const reserve = (): void => {
                this.#admission = { kind: "reserved" };
                signal.removeEventListener("abort", abort);
                resolve({
                    [Symbol.dispose]: () => {
                        this.#admission = { kind: "open" };
                    },
                });
            };
            this.#admission = { kind: "waiting", reserve };
            signal.addEventListener("abort", abort, { once: true });
            if (this.#turns.size === 0) {
                reserve();
            }
        });
    };
}
