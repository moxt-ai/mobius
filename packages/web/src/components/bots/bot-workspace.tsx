import { MobiusApiError, type MobiusBot, type MobiusBotOwnerClient } from "@moxt-ai/mobius-sdk";
import { LoaderCircle, MessageSquare, Plug, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router";

import { BotAvatar, BotInlineError, BotPageHeader, BotStatusBadge } from "@/components/bots/bot-page-header";
import { Button } from "@/components/ui/button";
import { useWorkspaceRoutes } from "@/components/workspace-route-provider";
import type { ChannelConnection } from "@/domain/channel";
import { isIdentifier } from "@/domain/channel";
import { cn } from "@/lib/utils";
import { createBotOwnerClient } from "@/services/bot-api";

abstract class BotWorkspaceState {}

class LoadingBotWorkspaceState extends BotWorkspaceState {}

class ReadyBotWorkspaceState extends BotWorkspaceState {
    readonly bot: MobiusBot;

    constructor(bot: MobiusBot) {
        super();
        this.bot = bot;
    }
}

class LinkedDeviceBotWorkspaceState extends BotWorkspaceState {}

class FailedBotWorkspaceState extends BotWorkspaceState {
    readonly message: string;

    constructor(message: string) {
        super();
        this.message = message;
    }
}

export interface BotDetailContext {
    readonly bot: MobiusBot;
    readonly client: MobiusBotOwnerClient;
    readonly connection: ChannelConnection;
    readonly refreshBot: () => Promise<MobiusBot>;
    readonly signal: AbortSignal;
}

function failureMessage(error: unknown): string {
    return error instanceof MobiusApiError ? `${error.code}: ${error.message}` : "The Bot could not be loaded.";
}

function BotTabs({ bot }: { readonly bot: MobiusBot }) {
    const routes = useWorkspaceRoutes();
    const linkClass = ({ isActive }: { readonly isActive: boolean }): string =>
        cn(
            "inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs font-medium text-muted-foreground no-underline transition-colors hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
            isActive && "bg-black/[0.065] text-foreground",
        );
    return (
        <nav aria-label="Bot sections" className="flex gap-1 overflow-x-auto px-5 pb-3 sm:px-8">
            <NavLink className={linkClass} end to={routes.botPath(bot.botId)}>
                <SlidersHorizontal aria-hidden="true" className="size-3.5" /> Overview
            </NavLink>
            <NavLink className={linkClass} to={routes.botConversationsPath(bot.botId)}>
                <MessageSquare aria-hidden="true" className="size-3.5" /> Conversations
            </NavLink>
            <NavLink className={linkClass} to={routes.botConnectionsPath(bot.botId)}>
                <Plug aria-hidden="true" className="size-3.5" /> Connections
            </NavLink>
        </nav>
    );
}

export function BotWorkspace({
    connection,
    desktopSidebarCollapsed,
    onToggleDesktopSidebar,
}: {
    readonly connection: ChannelConnection;
    readonly desktopSidebarCollapsed: boolean;
    readonly onToggleDesktopSidebar: () => void;
}) {
    const routes = useWorkspaceRoutes();
    const params = useParams<"botId">();
    const botId = params.botId ?? "";
    const [client] = useState(() => createBotOwnerClient(connection));
    const [controller] = useState(() => new AbortController());
    const [refreshing, setRefreshing] = useState(false);
    const [state, setState] = useState<BotWorkspaceState>(new LoadingBotWorkspaceState());

    const refreshBot = useCallback(async (): Promise<MobiusBot> => {
        setRefreshing(true);
        try {
            const bot = await client.readBot(botId, controller.signal);
            setState(new ReadyBotWorkspaceState(bot));
            return bot;
        } catch (error) {
            if (!controller.signal.aborted) {
                if (error instanceof MobiusApiError && error.code === "owner_access_required") {
                    setState(new LinkedDeviceBotWorkspaceState());
                } else {
                    setState(new FailedBotWorkspaceState(failureMessage(error)));
                }
            }
            throw error;
        } finally {
            if (!controller.signal.aborted) {
                setRefreshing(false);
            }
        }
    }, [botId, client, controller]);

    useEffect(() => {
        if (isIdentifier(botId)) {
            void refreshBot().catch(() => undefined);
        } else {
            setState(new FailedBotWorkspaceState("The Bot route is malformed."));
        }
        return () => controller.abort();
    }, [botId, controller, refreshBot]);

    if (state instanceof LoadingBotWorkspaceState) {
        return (
            <>
                <BotPageHeader
                    backLabel="All Bots"
                    backTo={routes.botDirectoryPath}
                    desktopSidebarCollapsed={desktopSidebarCollapsed}
                    onToggleDesktopSidebar={onToggleDesktopSidebar}
                    title="Opening Bot"
                />
                <div
                    aria-busy="true"
                    aria-live="polite"
                    className="flex min-h-64 flex-1 items-center justify-center gap-3 text-sm text-muted-foreground"
                >
                    <LoaderCircle aria-hidden="true" className="size-5 animate-spin" /> Loading Bot…
                </div>
            </>
        );
    }

    if (state instanceof LinkedDeviceBotWorkspaceState) {
        return (
            <>
                <BotPageHeader
                    backLabel="All Bots"
                    backTo={routes.botDirectoryPath}
                    desktopSidebarCollapsed={desktopSidebarCollapsed}
                    onToggleDesktopSidebar={onToggleDesktopSidebar}
                    title="Bot management"
                />
                <div className="mx-auto mt-10 w-[min(640px,calc(100%-40px))] rounded-2xl border-[0.5px] border-black/10 bg-white p-6 text-center">
                    <h2 className="text-base font-semibold">Owner access required</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        This linked browser can use Agent conversations, but it cannot manage Bot identities or read
                        owner conversations.
                    </p>
                </div>
            </>
        );
    }

    if (state instanceof FailedBotWorkspaceState) {
        return (
            <>
                <BotPageHeader
                    backLabel="All Bots"
                    backTo={routes.botDirectoryPath}
                    desktopSidebarCollapsed={desktopSidebarCollapsed}
                    onToggleDesktopSidebar={onToggleDesktopSidebar}
                    title="Bot unavailable"
                />
                <div className="mx-auto mt-10 w-[min(640px,calc(100%-40px))] rounded-2xl border border-[#f2c4c4] bg-[#fff7f7] p-6 text-center">
                    <h2 className="text-base font-semibold text-[#9b2c32]">Bot unavailable</h2>
                    <BotInlineError>{state.message}</BotInlineError>
                    <Button
                        className="mt-5 min-h-11"
                        onClick={() => void refreshBot().catch(() => undefined)}
                        variant="outline"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry
                    </Button>
                </div>
            </>
        );
    }

    if (!(state instanceof ReadyBotWorkspaceState)) {
        return null;
    }
    const context: BotDetailContext = {
        bot: state.bot,
        client,
        connection,
        refreshBot,
        signal: controller.signal,
    };
    return (
        <>
            <BotPageHeader
                backLabel="All Bots"
                backTo={routes.botDirectoryPath}
                desktopSidebarCollapsed={desktopSidebarCollapsed}
                leading={<BotAvatar bot={state.bot} className="size-8 rounded-[9px] text-[11px]" />}
                onToggleDesktopSidebar={onToggleDesktopSidebar}
                title={state.bot.displayName}
            />
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="shrink-0 border-b-[0.5px] border-black/6 bg-white/55 pt-3">
                    <div className="flex items-center justify-between gap-3 px-5 pb-2 sm:px-8">
                        <div className="flex min-w-0 items-center gap-2">
                            <BotStatusBadge bot={state.bot} />
                            <span className="truncate font-mono text-[10px] text-muted-foreground">
                                {state.bot.botId}
                            </span>
                        </div>
                        <Button
                            aria-busy={refreshing}
                            className="min-h-11 shrink-0 sm:min-h-9"
                            disabled={refreshing}
                            onClick={() => void refreshBot().catch(() => undefined)}
                            variant="ghost"
                        >
                            <RefreshCw aria-hidden="true" className={cn("size-3.5", refreshing && "animate-spin")} />
                            Refresh Bot
                        </Button>
                    </div>
                    <BotTabs bot={state.bot} />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <Outlet context={context} />
                </div>
            </div>
        </>
    );
}
