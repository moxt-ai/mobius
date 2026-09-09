import type { BotOwnerAccess, ProjectOwnerAccess } from "../../entity/bot/bot-access.ts";
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

    readonly listBots = async (access: ProjectOwnerAccess, signal: AbortSignal) => ({
        bots: (await this.#control.listBots(access, signal)).map(botResource),
    });

    readonly listBehaviorRevisions = async (access: BotOwnerAccess, signal: AbortSignal) => ({
        behaviorRevisions: (await this.#control.listBehaviorRevisions(access, signal)).map(behaviorResource),
    });

    readonly listExecutionBindings = async (access: BotOwnerAccess, signal: AbortSignal) => ({
        executionBindings: (await this.#control.listExecutionBindings(access, signal)).map(bindingResource),
    });

    readonly listConnections = async (access: BotOwnerAccess, signal: AbortSignal) => {
        const rows = await this.#connections.listForOwner(access, signal);
        return {
            connections: rows.connections.map(connectionResource),
            deliveryTargets: rows.deliveryTargets.map(targetResource),
        };
    };

    readonly listConversations = async (access: BotOwnerAccess, signal: AbortSignal) => ({
        conversations: (await this.#conversations.listForOwner(access, signal)).map(conversationResponse),
    });
}
