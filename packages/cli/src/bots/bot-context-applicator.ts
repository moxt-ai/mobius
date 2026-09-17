import type { BotSessionPromptCommand, PromptResource } from "@moxt-ai/mobius-protocol";

import type { AuthorizedLocalBotExecution } from "./local-bot-execution-authorizer.ts";
import { LocalBotAuthorizationError } from "./local-bot-execution-authorizer.ts";

export class AppliedBotContext {
    readonly resources: readonly PromptResource[];

    constructor(resources: readonly PromptResource[]) {
        this.resources = Object.freeze([...resources]);
    }
}

interface BotContextApplicator {
    readonly apply: (
        command: BotSessionPromptCommand,
        execution: AuthorizedLocalBotExecution,
        resources: readonly PromptResource[],
        signal: AbortSignal,
    ) => Promise<AppliedBotContext>;
}

export class EmbeddedBotContextApplicator implements BotContextApplicator {
    readonly apply = async (
        command: BotSessionPromptCommand,
        execution: AuthorizedLocalBotExecution,
        resources: readonly PromptResource[],
        signal: AbortSignal,
    ): Promise<AppliedBotContext> => {
        signal.throwIfAborted();
        if (
            execution.botId !== command.botId ||
            execution.behaviorRevisionId !== command.behaviorRevisionId ||
            execution.behaviorDigest !== command.behaviorDigest
        ) {
            throw new LocalBotAuthorizationError(
                "binding_incompatible",
                "The Bot behavior does not match the execution target",
            );
        }
        if (command.behaviorInstructions.length === 0) {
            return new AppliedBotContext(resources);
        }
        if (!execution.agent.capabilities.embeddedContextPrompt) {
            throw new LocalBotAuthorizationError(
                "binding_incompatible",
                "The local Agent cannot enforce the Bot behavior context",
            );
        }
        const trustedContext: PromptResource = {
            mimeType: "text/markdown",
            name: "Mobius Bot behavior",
            text: command.behaviorInstructions,
            type: "embedded",
            uri: `mobius://bots/${encodeURIComponent(command.botId)}/behavior-revisions/${encodeURIComponent(command.behaviorRevisionId)}?sha256=${command.behaviorDigest}`,
        };
        return new AppliedBotContext([trustedContext, ...resources]);
    };
}
