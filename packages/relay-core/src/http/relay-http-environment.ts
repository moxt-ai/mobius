import type { RelayContext } from "../di/create-relay-dependencies.ts";

export type RelayHttpEnvironment = {
    readonly Bindings: RelayContext;
    readonly Variables: { readonly signal: AbortSignal };
};
