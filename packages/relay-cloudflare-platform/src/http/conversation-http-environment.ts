import type { BotService, RelayContext } from "@moxt-ai/mobius-relay-core";
import type { ConversationAccessService } from "../service/conversation-access-service.ts";
import type { ConversationStreamRegistry } from "../service/conversation-stream-service.ts";

export interface ConversationHttpBindings {
    readonly access: ConversationAccessService;
    readonly allowedOrigins: ReadonlySet<string>;
    readonly bots: BotService;
    readonly nowEpochMilliseconds: () => number;
    readonly sessions: RelayContext["services"]["sessions"];
    readonly streams: ConversationStreamRegistry;
}

export interface ConversationHttpEnvironment {
    readonly Bindings: ConversationHttpBindings;
    readonly Variables: { readonly signal: AbortSignal };
}
