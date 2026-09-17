import { MobiusApiError, type MobiusBot, type MobiusBotOwnerClient } from "@moxt-ai/mobius-sdk";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

import type { ChannelConnection } from "@/domain/channel";
import { createBotOwnerClient } from "@/services/bot-api";

export abstract class BotTargetDirectoryState {}

export class UnavailableBotTargetDirectoryState extends BotTargetDirectoryState {
    readonly message: string;

    constructor(message: string) {
        super();
        this.message = message;
    }
}

export class LoadingBotTargetDirectoryState extends BotTargetDirectoryState {}

export class ReadyBotTargetDirectoryState extends BotTargetDirectoryState {
    readonly bots: readonly MobiusBot[];

    constructor(bots: readonly MobiusBot[]) {
        super();
        this.bots = bots;
    }
}

export class FailedBotTargetDirectoryState extends BotTargetDirectoryState {
    readonly message: string;

    constructor(message: string) {
        super();
        this.message = message;
    }
}

interface ConversationTargetContextValue {
    readonly botDirectory: BotTargetDirectoryState;
    readonly createBotConversation: (bot: MobiusBot) => Promise<void>;
    readonly refreshBots: () => Promise<void>;
}

const unavailableContext: ConversationTargetContextValue = {
    botDirectory: new UnavailableBotTargetDirectoryState(
        "Bot conversations are available from a paired Mobius Web workspace.",
    ),
    createBotConversation: (): Promise<void> =>
        Promise.reject(new Error("Bot conversations are unavailable outside a paired Mobius Web workspace.")),
    refreshBots: (): Promise<void> => Promise.resolve(),
};

const ConversationTargetContext = createContext<ConversationTargetContextValue>(unavailableContext);

function directoryFailure(error: unknown): FailedBotTargetDirectoryState {
    if (error instanceof MobiusApiError && error.code === "owner_access_required") {
        return new FailedBotTargetDirectoryState(
            "Owner access is required to start Bot conversations from this browser.",
        );
    }
    if (error instanceof MobiusApiError) {
        return new FailedBotTargetDirectoryState(`${error.code}: ${error.message}`);
    }
    return new FailedBotTargetDirectoryState("The Bot directory could not be loaded.");
}

export function ConversationTargetProvider({
    children,
    connection,
    onOpenBotConversation,
}: {
    readonly children: ReactNode;
    readonly connection: ChannelConnection;
    readonly onOpenBotConversation: (botId: string, conversationId: string) => void;
}) {
    const [client] = useState<MobiusBotOwnerClient>(() => createBotOwnerClient(connection));
    const [controller] = useState(() => new AbortController());
    const [botDirectory, setBotDirectory] = useState<BotTargetDirectoryState>(
        new UnavailableBotTargetDirectoryState("Open the Bots tab to load this project's Bots."),
    );
    const botDirectoryRef = useRef<BotTargetDirectoryState>(botDirectory);

    const transitionDirectory = useCallback((next: BotTargetDirectoryState): void => {
        botDirectoryRef.current = next;
        setBotDirectory(next);
    }, []);

    const refreshBots = useCallback(async (): Promise<void> => {
        if (botDirectoryRef.current instanceof LoadingBotTargetDirectoryState) {
            return;
        }
        transitionDirectory(new LoadingBotTargetDirectoryState());
        try {
            const directory = await client.listBots(controller.signal);
            if (!controller.signal.aborted) {
                transitionDirectory(new ReadyBotTargetDirectoryState(directory.bots));
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                transitionDirectory(directoryFailure(error));
            }
        }
    }, [client, controller, transitionDirectory]);

    const createBotConversation = useCallback(
        async (bot: MobiusBot): Promise<void> => {
            if (bot.state.kind !== "active") {
                throw new Error("Activate this Bot before starting a conversation.");
            }
            const conversation = await client.createConversation(
                bot.botId,
                {
                    clientConversationKey: `web_${crypto.randomUUID()}`,
                },
                controller.signal,
            );
            controller.signal.throwIfAborted();
            onOpenBotConversation(bot.botId, conversation.conversationId);
        },
        [client, controller, onOpenBotConversation],
    );

    useEffect(() => () => controller.abort(), [controller]);

    return (
        <ConversationTargetContext.Provider value={{ botDirectory, createBotConversation, refreshBots }}>
            {children}
        </ConversationTargetContext.Provider>
    );
}

export function useConversationTargets(): ConversationTargetContextValue {
    return useContext(ConversationTargetContext);
}
