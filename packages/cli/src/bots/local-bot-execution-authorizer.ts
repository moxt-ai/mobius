import type { AgentExecutionConfiguration, BotSessionPromptCommand } from "@moxt-ai/mobius-protocol";

import { AgentPermissionConfigurationError } from "../agent-catalog/agent-permission-profile.ts";
import type { LocalAgentCatalog, LocalAgentDefinition } from "../agent-catalog/local-agent.ts";
import type { WorkspaceDirectoryService } from "../authorization/workspace-directory.ts";
import { revalidateExecutable } from "../process/executable.ts";

export class LocalBotAuthorizationError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "LocalBotAuthorizationError";
    }
}

export class AuthorizedLocalBotExecution {
    readonly agent: LocalAgentDefinition;
    readonly behaviorDigest: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly executionConfiguration: AgentExecutionConfiguration;
    readonly workspacePath: string;
    readonly workspaceRef: string;

    constructor(command: BotSessionPromptCommand, agent: LocalAgentDefinition, workspacePath: string) {
        this.agent = agent;
        this.behaviorDigest = command.behaviorDigest;
        this.behaviorRevisionId = command.behaviorRevisionId;
        this.bindingId = command.bindingId;
        this.bindingRevision = command.bindingRevision;
        this.botId = command.botId;
        this.executionConfiguration = command.executionConfiguration;
        this.workspacePath = workspacePath;
        this.workspaceRef = command.directoryId;
    }
}

export class LocalBotExecutionAuthorizer {
    readonly authorize = async (
        command: BotSessionPromptCommand,
        catalog: LocalAgentCatalog,
        directories: WorkspaceDirectoryService,
        bindingAuthorityId: string,
        signal: AbortSignal,
    ): Promise<AuthorizedLocalBotExecution> => {
        signal.throwIfAborted();
        let agent: LocalAgentDefinition;
        try {
            agent = catalog.find(command.agentId).withPermissionMode(command.executionConfiguration.permissionMode);
        } catch (cause) {
            if (cause instanceof AgentPermissionConfigurationError) {
                throw new LocalBotAuthorizationError("binding_incompatible", cause.message, { cause });
            }
            throw cause;
        }
        const [adapterUnchanged, agentUnchanged] = await Promise.all([
            revalidateExecutable(agent.adapterIdentity),
            revalidateExecutable(agent.agentIdentity),
        ]);
        signal.throwIfAborted();
        if (!adapterUnchanged || !agentUnchanged) {
            throw new LocalBotAuthorizationError(
                "binding_incompatible",
                "The local Agent executable changed while the Runtime is active; restart the Runtime",
            );
        }
        if (command.behaviorInstructions.length > 0 && !agent.capabilities.embeddedContextPrompt) {
            throw new LocalBotAuthorizationError(
                "binding_incompatible",
                "The local Agent cannot apply the Bot behavior",
            );
        }
        const workspacePath = await directories.resolve(bindingAuthorityId, command.directoryId, signal);
        signal.throwIfAborted();
        return new AuthorizedLocalBotExecution(command, agent, workspacePath);
    };
}
