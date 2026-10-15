import type { ServiceToDaemonMessage } from "@moxt-ai/mobius-protocol";
import type { CommandContext } from "./context.ts";

export interface DaemonCommand {
    readonly kind: ServiceToDaemonMessage["kind"];
    readonly handle: (context: CommandContext, message: ServiceToDaemonMessage) => void;
    readonly settle?: () => Promise<void>;
}
