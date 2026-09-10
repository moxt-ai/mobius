import type { ProjectAccessContext } from "../../entity/authentication/project-authentication.ts";
import type { ProjectBotAccess } from "../../entity/bot/bot-access.ts";
import { conversationResponse } from "../../entity/bot/bot-conversation.ts";
import type { BotConnectionStorage } from "../../storage/bot-connection-storage.ts";
import type { BotControlStorage } from "../../storage/bot-control-storage.ts";
import type { BotConversationStorage } from "../../storage/bot-conversation-storage.ts";
import { behaviorResource, bindingResource, botResource, connectionResource, targetResource } from "./bot-resource.ts";

export class BotManagementService {
    readonly #control: BotControlStorage;
    readonly #connections: BotConnectionStorage;
    readonly #conversations: BotConversationStorage;

    constructor(control: BotControlStorage, connections: BotConnectionStorage, conversations: BotConversationStorage) {
        this.#control = control;
        this.#connections = connections;
        this.#conversations = conversations;
    }

    readonly listBots = async (access: ProjectAccessContext, signal: AbortSignal) => ({
        bots: (await this.#control.listBots(access, signal)).map(botResource),
    });

    readonly listBehaviorRevisions = async (access: ProjectBotAccess, signal: AbortSignal) => ({
        behaviorRevisions: (await this.#control.listBehaviorRevisions(access, signal)).map(behaviorResource),
    });

    readonly listExecutionBindings = async (access: ProjectBotAccess, signal: AbortSignal) => ({
        executionBindings: (await this.#control.listExecutionBindings(access, signal)).map(bindingResource),
    });

    readonly listConnections = async (access: ProjectBotAccess, signal: AbortSignal) => {
        const rows = await this.#connections.listForProject(access, signal);
        return {
            connections: rows.connections.map(connectionResource),
            deliveryTargets: rows.deliveryTargets.map(targetResource),
        };
    };

    readonly listConversations = async (access: ProjectBotAccess, signal: AbortSignal) => ({
        conversations: (await this.#conversations.listForProject(access, signal)).map(conversationResponse),
    });
}
