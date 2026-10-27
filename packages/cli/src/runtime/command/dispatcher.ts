import type { ServiceToDaemonMessage } from "@moxt-ai/mobius-sdk/protocol";
import type { CommandContext } from "./context.ts";
import { createCommandRegistry } from "./registry/index.ts";

export function createRuntimeCommandDispatcher(options: CommandContext): {
    readonly dispatch: (message: ServiceToDaemonMessage) => void;
    readonly dispatchChunk: (message: unknown) => void;
    readonly settle: () => Promise<void>;
} {
    return createCommandRegistry(options);
}
