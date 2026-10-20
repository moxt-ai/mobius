import type { ServiceToDaemonMessage } from "@moxt-ai/mobius-sdk/protocol";
import type { CommandContext } from "./context.ts";

export interface RuntimeCommand {
    readonly kind: ServiceToDaemonMessage["kind"];
    readonly handle: (context: CommandContext, message: ServiceToDaemonMessage) => void;
    readonly settle?: () => Promise<void>;
}
