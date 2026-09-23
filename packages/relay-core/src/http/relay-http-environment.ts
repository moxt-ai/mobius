import type { RelayContext } from "../di/create-relay-dependencies.ts";
import type { OperationTiming } from "../infra/operation-timing.ts";

export type RelayHttpEnvironment = {
    readonly Bindings: RelayContext;
    readonly Variables: { readonly operationTiming: OperationTiming; readonly signal: AbortSignal };
};
