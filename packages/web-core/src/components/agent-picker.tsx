import { MobiusApiError, type MobiusBot } from "@moxt-ai/mobius-sdk";
import { Check, ChevronDown, LoaderCircle, RefreshCw } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { AgentProductIcon } from "@/components/agent-product-icon";
import { BotAvatar } from "@/components/bots/bot-page-header";
import {
    FailedBotTargetDirectoryState,
    LoadingBotTargetDirectoryState,
    ReadyBotTargetDirectoryState,
    UnavailableBotTargetDirectoryState,
    useConversationTargets,
} from "@/components/conversation-target-provider";
import { cn } from "@/lib/utils";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

abstract class ConversationTargetTab {}

class LocalAgentsTargetTab extends ConversationTargetTab {}

class BotsTargetTab extends ConversationTargetTab {}

abstract class BotConversationLaunchState {}

class IdleBotConversationLaunchState extends BotConversationLaunchState {}

class LaunchingBotConversationState extends BotConversationLaunchState {
    readonly botId: string;

    constructor(botId: string) {
        super();
        this.botId = botId;
    }
}

class FailedBotConversationLaunchState extends BotConversationLaunchState {
    readonly message: string;

    constructor(message: string) {
        super();
        this.message = message;
    }
}

function botStatusLabel(bot: MobiusBot): string {
    if (bot.state.kind === "active") {
        return "Active";
    }
    if (bot.state.kind === "draft") {
        return "Draft";
    }
    if (bot.state.kind === "suspended") {
        return "Suspended";
    }
    return "Archived";
}

function botLaunchFailure(error: unknown): FailedBotConversationLaunchState {
    if (error instanceof MobiusApiError) {
        return new FailedBotConversationLaunchState(`${error.code}: ${error.message}`);
    }
    if (error instanceof Error) {
        return new FailedBotConversationLaunchState(error.message);
    }
    return new FailedBotConversationLaunchState("The Bot conversation could not be created.");
}

export function AgentPicker() {
    const agents = useChatStore((state) => state.agents);
    const conversation = useChatStore(selectActiveConversation);
    const selectAgent = useChatStore((state) => state.selectAgent);
    const { botDirectory, createBotConversation, refreshBots } = useConversationTargets();
    const [open, setOpen] = useState(false);
    const [selectedTab, setSelectedTab] = useState<ConversationTargetTab>(new LocalAgentsTargetTab());
    const [launch, setLaunch] = useState<BotConversationLaunchState>(new IdleBotConversationLaunchState());
    const wrapperRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const localAgentsTabRef = useRef<HTMLButtonElement>(null);
    const botsTabRef = useRef<HTMLButtonElement>(null);
    const pickerId = useId();
    const localAgentsTabId = useId();
    const localAgentsPanelId = useId();
    const botsTabId = useId();
    const botsPanelId = useId();
    const locked = conversation.contextLocked || conversation.isRunning;

    useEffect(() => {
        if (!open) {
            return;
        }
        const controller = new AbortController();
        document.addEventListener(
            "pointerdown",
            (event) => {
                if (event.target instanceof Node && wrapperRef.current?.contains(event.target) !== true) {
                    setOpen(false);
                }
            },
            { signal: controller.signal },
        );
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    setOpen(false);
                    triggerRef.current?.focus({ preventScroll: true });
                }
            },
            { signal: controller.signal },
        );
        return () => controller.abort();
    }, [open]);

    const openBotsTab = (): void => {
        setSelectedTab(new BotsTargetTab());
        setLaunch(new IdleBotConversationLaunchState());
        void refreshBots();
    };

    const openLocalAgentsTab = (): void => {
        setSelectedTab(new LocalAgentsTargetTab());
        setLaunch(new IdleBotConversationLaunchState());
    };

    const moveTabFocus = (
        event: KeyboardEvent<HTMLButtonElement>,
        tab: ConversationTargetTab,
        target: HTMLButtonElement | null,
    ): void => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
        }
        event.preventDefault();
        if (tab instanceof BotsTargetTab) {
            openBotsTab();
        } else {
            openLocalAgentsTab();
        }
        target?.focus({ preventScroll: true });
    };

    const launchBot = async (bot: MobiusBot): Promise<void> => {
        if (bot.state.kind !== "active" || launch instanceof LaunchingBotConversationState) {
            return;
        }
        setLaunch(new LaunchingBotConversationState(bot.botId));
        try {
            await createBotConversation(bot);
            setOpen(false);
        } catch (error) {
            setLaunch(botLaunchFailure(error));
        }
    };

    const listedBots = botDirectory instanceof ReadyBotTargetDirectoryState ? botDirectory.bots : [];

    return (
        <div className="relative shrink-0" ref={wrapperRef}>
            <button
                aria-controls={pickerId}
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-label="Agent or Bot for this conversation"
                className={cn(
                    "inline-flex h-11 w-11 min-w-0 shrink-0 items-center justify-center gap-0 rounded-full border-0 bg-transparent px-0 text-xs font-medium text-muted-foreground shadow-none outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-black/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-default disabled:opacity-100 lg:h-9 lg:w-auto lg:max-w-[180px] lg:justify-between lg:gap-2 lg:bg-black/[0.035] lg:px-2.5",
                    locked && "max-sm:hidden",
                )}
                disabled={locked}
                onClick={() => {
                    const nextOpen = !open;
                    setOpen(nextOpen);
                    setLaunch(new IdleBotConversationLaunchState());
                    if (nextOpen && selectedTab instanceof BotsTargetTab) {
                        void refreshBots();
                    }
                }}
                ref={triggerRef}
                title={locked ? "Start a new chat to choose another target" : "Choose a local Agent or Bot"}
                type="button"
            >
                <span className="flex min-w-0 items-center gap-0 lg:gap-2">
                    <AgentProductIcon
                        agentId={conversation.agentId}
                        agentLabel={conversation.agentLabel}
                        className="size-[18px] rounded-[5px]"
                    />
                    <span className="sr-only lg:not-sr-only lg:truncate">{conversation.agentLabel}</span>
                </span>
                <ChevronDown
                    aria-hidden="true"
                    className={cn(
                        "hidden size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none lg:block",
                        open && "rotate-180",
                    )}
                />
            </button>

            {open && (
                <section
                    aria-label="Choose conversation target"
                    className="fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] left-3 z-50 overflow-hidden rounded-xl border-[0.5px] border-black/10 bg-white shadow-[0_14px_42px_rgba(0,0,0,0.16)] lg:absolute lg:right-auto lg:bottom-[calc(100%+8px)] lg:left-0 lg:w-80"
                    id={pickerId}
                    role="dialog"
                >
                    <div
                        aria-label="Conversation target type"
                        className="grid grid-cols-2 gap-1 border-b-[0.5px] border-black/8 bg-surface-subtle p-1.5"
                        role="tablist"
                    >
                        <button
                            aria-controls={localAgentsPanelId}
                            aria-selected={selectedTab instanceof LocalAgentsTargetTab}
                            className={cn(
                                "min-h-11 rounded-lg px-3 text-xs font-semibold text-muted-foreground outline-none transition-colors duration-150 motion-reduce:transition-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70",
                                selectedTab instanceof LocalAgentsTargetTab &&
                                    "bg-white text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.08)]",
                            )}
                            id={localAgentsTabId}
                            onClick={openLocalAgentsTab}
                            onKeyDown={(event) => moveTabFocus(event, new BotsTargetTab(), botsTabRef.current)}
                            ref={localAgentsTabRef}
                            role="tab"
                            tabIndex={selectedTab instanceof LocalAgentsTargetTab ? 0 : -1}
                            type="button"
                        >
                            Local Agents
                        </button>
                        <button
                            aria-controls={botsPanelId}
                            aria-selected={selectedTab instanceof BotsTargetTab}
                            className={cn(
                                "min-h-11 rounded-lg px-3 text-xs font-semibold text-muted-foreground outline-none transition-colors duration-150 motion-reduce:transition-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70",
                                selectedTab instanceof BotsTargetTab &&
                                    "bg-white text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.08)]",
                            )}
                            id={botsTabId}
                            onClick={openBotsTab}
                            onKeyDown={(event) =>
                                moveTabFocus(event, new LocalAgentsTargetTab(), localAgentsTabRef.current)
                            }
                            ref={botsTabRef}
                            role="tab"
                            tabIndex={selectedTab instanceof BotsTargetTab ? 0 : -1}
                            type="button"
                        >
                            Bots
                        </button>
                    </div>

                    <div
                        aria-labelledby={localAgentsTabId}
                        className="max-h-72 overflow-y-auto p-1.5"
                        hidden={selectedTab instanceof BotsTargetTab}
                        id={localAgentsPanelId}
                        role="tabpanel"
                    >
                        {agents.map((agent) => (
                            <button
                                aria-current={agent.id === conversation.agentId ? "true" : undefined}
                                className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-xs outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/70"
                                key={agent.id}
                                onClick={() => {
                                    if (agent.id !== conversation.agentId) {
                                        selectAgent(agent.id);
                                    }
                                    setOpen(false);
                                }}
                                type="button"
                            >
                                <AgentProductIcon agentId={agent.id} agentLabel={agent.label} />
                                <span className="min-w-0 flex-1 truncate font-medium">{agent.label}</span>
                                {agent.id === conversation.agentId && (
                                    <Check aria-hidden="true" className="size-3.5 shrink-0 text-success" />
                                )}
                            </button>
                        ))}
                    </div>

                    <div
                        aria-labelledby={botsTabId}
                        className="max-h-72 overflow-y-auto p-1.5"
                        hidden={selectedTab instanceof LocalAgentsTargetTab}
                        id={botsPanelId}
                        role="tabpanel"
                    >
                        {botDirectory instanceof LoadingBotTargetDirectoryState && (
                            <p
                                aria-busy="true"
                                className="flex min-h-20 items-center justify-center gap-2 text-xs text-muted-foreground"
                                role="status"
                            >
                                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading Bots…
                            </p>
                        )}
                        {botDirectory instanceof UnavailableBotTargetDirectoryState && (
                            <p className="px-3 py-5 text-center text-xs leading-5 text-muted-foreground">
                                {botDirectory.message}
                            </p>
                        )}
                        {botDirectory instanceof FailedBotTargetDirectoryState && (
                            <div className="px-3 py-4 text-center">
                                <p className="text-xs leading-5 text-[#9b2c32]" role="alert">
                                    {botDirectory.message}
                                </p>
                                <button
                                    className="mx-auto mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-foreground outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/70"
                                    onClick={() => void refreshBots()}
                                    type="button"
                                >
                                    <RefreshCw aria-hidden="true" className="size-3.5" /> Retry
                                </button>
                            </div>
                        )}
                        {botDirectory instanceof ReadyBotTargetDirectoryState && listedBots.length === 0 && (
                            <p className="px-3 py-5 text-center text-xs leading-5 text-muted-foreground">
                                No Bots are available. Create and activate one from Bots in the sidebar.
                            </p>
                        )}
                        {botDirectory instanceof ReadyBotTargetDirectoryState &&
                            listedBots.map((bot) => {
                                const active = bot.state.kind === "active";
                                const launching =
                                    launch instanceof LaunchingBotConversationState && launch.botId === bot.botId;
                                const status = botStatusLabel(bot);
                                return (
                                    <button
                                        aria-busy={launching}
                                        aria-label={`${bot.displayName}, ${status}`}
                                        className="flex min-h-14 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-55"
                                        disabled={!active || launch instanceof LaunchingBotConversationState}
                                        key={bot.botId}
                                        onClick={() => void launchBot(bot)}
                                        type="button"
                                    >
                                        <BotAvatar bot={bot} className="size-8 rounded-[9px] text-[11px]" />
                                        <span className="min-w-0 flex-1">
                                            <strong className="block truncate text-xs font-semibold">
                                                {bot.displayName}
                                            </strong>
                                            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                                                {active ? "Start a durable conversation" : `${status} · unavailable`}
                                            </span>
                                        </span>
                                        {launching ? (
                                            <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
                                        ) : (
                                            <span
                                                className={cn(
                                                    "rounded-full bg-black/5 px-2 py-1 text-[10px] font-semibold text-muted-foreground",
                                                    active && "bg-[#e8f8ef] text-[#187747]",
                                                )}
                                            >
                                                {status}
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        {launch instanceof FailedBotConversationLaunchState && (
                            <p
                                className="mx-2 mb-2 rounded-lg bg-[#fff7f7] px-3 py-2 text-xs leading-5 text-[#9b2c32]"
                                role="alert"
                            >
                                {launch.message}
                            </p>
                        )}
                    </div>
                </section>
            )}
        </div>
    );
}
