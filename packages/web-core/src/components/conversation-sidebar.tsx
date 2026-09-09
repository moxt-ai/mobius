import { Bot, Laptop, LoaderCircle, MessageSquare, Plus, Settings, Smartphone, X } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useRef } from "react";
import { Link, NavLink } from "react-router";

import { AgentInstallationSidebarPanel } from "@/components/agent-installation-panel";
import { NativeSessionBrowser } from "@/components/native-session-browser";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { SidebarRuntimeStatus } from "@/components/sidebar-runtime-status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    botDirectoryRoutePath,
    channelAccessRoutePath,
    channelRuntimesRoutePath,
    channelSettingsRoutePath,
    sessionRoutePath,
    sessionSettingsRoutePath,
} from "@/services/app-routes";
import {
    type DesktopSidebarLayoutState,
    finishSidebarResize,
    resetSidebar,
    resizeSidebar,
    sidebarDisplayWidth,
} from "@/services/workspace-layout";
import { useChatStore } from "@/store/chat-store";

const FOCUSABLE_CONTROL_SELECTOR = [
    "button:not([disabled])",
    "[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
].join(",");

function sidebarAccessibility(open: boolean): ComponentProps<"div"> {
    if (open) {
        return {
            "aria-label": "Conversation sidebar",
            "aria-modal": true,
            role: "dialog",
            tabIndex: -1,
        };
    }
    return {
        "aria-label": "Conversation sidebar",
        role: "complementary",
    };
}

function MobiusMark() {
    return (
        <svg
            aria-hidden="true"
            className="size-[25px] fill-none stroke-success stroke-[2.2] [stroke-linecap:round] [stroke-linejoin:round]"
            viewBox="0 0 32 32"
        >
            <path d="M7 9.5C7 6.46 9.46 4 12.5 4S18 6.46 18 9.5 15.54 15 12.5 15H11" />
            <path d="M25 22.5c0 3.04-2.46 5.5-5.5 5.5S14 25.54 14 22.5s2.46-5.5 5.5-5.5H21" />
            <path d="M11 15h10M21 17H11" />
        </svg>
    );
}

interface ConversationSidebarProps {
    readonly channelId: string;
    readonly layout: DesktopSidebarLayoutState;
    readonly managementPageOpen: boolean;
    readonly onCreateConversation: () => void;
    readonly onLayoutChange: (layout: DesktopSidebarLayoutState) => void;
}

export function ConversationSidebar({
    channelId,
    layout,
    managementPageOpen,
    onCreateConversation,
    onLayoutChange,
}: ConversationSidebarProps) {
    const conversations = useChatStore((state) => state.conversations);
    const activeConversationId = useChatStore((state) => state.activeConversationId);
    const agents = useChatStore((state) => state.agents);
    const runtime = useChatStore((state) => state.runtime);
    const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
    const sidebarOpen = useChatStore((state) => state.sidebarOpen);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const sidebarRef = useRef<HTMLDivElement>(null);
    const machineName = useChatStore((state) => state.machineName);
    const runningConversations = conversations.filter((conversation) => conversation.isRunning);
    const recentConversations = conversations.filter((conversation) => !conversation.isRunning);
    const displayWidth = sidebarDisplayWidth(layout);
    const accessPath = channelAccessRoutePath(channelId);
    const runtimesPath = channelRuntimesRoutePath(channelId);
    const botsPath = botDirectoryRoutePath(channelId);
    const activeSessionId = conversations.find((conversation) => conversation.id === activeConversationId)?.sessionId;
    const settingsPath =
        activeSessionId === undefined
            ? channelSettingsRoutePath(channelId)
            : sessionSettingsRoutePath(channelId, activeSessionId);

    const closeSidebar = useCallback((): void => {
        if (!sidebarOpen) {
            return;
        }
        setSidebarOpen(false);
        window.requestAnimationFrame(() => {
            document.getElementById("conversation-sidebar-trigger")?.focus();
        });
    }, [setSidebarOpen, sidebarOpen]);

    useEffect(() => {
        if (!sidebarOpen) {
            return;
        }
        const focusFrame = window.requestAnimationFrame(() => {
            closeButtonRef.current?.focus({ preventScroll: true });
        });
        const controller = new AbortController();
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    closeSidebar();
                    return;
                }
                if (event.key !== "Tab" || sidebarRef.current === null) {
                    return;
                }
                const controls = Array.from(
                    sidebarRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_CONTROL_SELECTOR),
                ).filter((control) => control.getClientRects().length > 0);
                const first = controls[0];
                const last = controls.at(-1);
                const activeElement = document.activeElement;
                if (first === undefined || last === undefined) {
                    event.preventDefault();
                    sidebarRef.current.focus({ preventScroll: true });
                    return;
                }
                if (event.shiftKey && (activeElement === first || activeElement === sidebarRef.current)) {
                    event.preventDefault();
                    last.focus({ preventScroll: true });
                } else if (!event.shiftKey && activeElement === last) {
                    event.preventDefault();
                    first.focus({ preventScroll: true });
                }
            },
            { signal: controller.signal },
        );
        return () => {
            window.cancelAnimationFrame(focusFrame);
            controller.abort();
        };
    }, [closeSidebar, sidebarOpen]);

    useEffect(() => {
        const desktop = window.matchMedia("(min-width: 1024px)");
        const handleChange = (event: MediaQueryListEvent): void => {
            if (event.matches) {
                setSidebarOpen(false);
            }
        };
        desktop.addEventListener("change", handleChange);
        return () => desktop.removeEventListener("change", handleChange);
    }, [setSidebarOpen]);

    const conversationButton = (conversation: (typeof conversations)[number]) => {
        return (
            <NavLink
                className={({ isActive }) =>
                    cn(
                        "grid min-h-11 w-full grid-cols-[24px_minmax(0,1fr)] items-center rounded-[9px] px-2.5 py-1.5 text-left text-sm font-medium text-foreground no-underline outline-none transition-colors duration-150 hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        isActive && "bg-black/8 hover:bg-black/8",
                    )
                }
                end
                key={conversation.id}
                onClick={closeSidebar}
                to={sessionRoutePath(channelId, conversation.sessionId)}
            >
                <span
                    className={cn(
                        "inline-flex size-5 items-center justify-center rounded-md bg-white text-copy-secondary shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)]",
                        conversation.isRunning && "text-primary",
                    )}
                >
                    {conversation.isRunning ? (
                        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                    ) : (
                        <MessageSquare className="size-3" />
                    )}
                </span>
                <span className="min-w-0">
                    <strong className="block truncate text-[13px] leading-[18px] font-medium text-foreground">
                        {conversation.title}
                    </strong>
                    <span className="block truncate text-[11px] leading-4 font-normal text-muted-foreground">
                        {conversation.isRunning ? conversation.activeStateLabel : conversation.preview}
                    </span>
                </span>
            </NavLink>
        );
    };

    return (
        <>
            {sidebarOpen && (
                <button
                    aria-label="Dismiss conversation sidebar"
                    className="fixed inset-0 z-30 bg-black/35 backdrop-blur-[1px] lg:hidden"
                    onClick={closeSidebar}
                    type="button"
                />
            )}
            <div
                className={cn(
                    "contents lg:relative lg:block lg:h-full lg:shrink-0",
                    layout.kind === "collapsed" && "lg:w-0",
                )}
                data-sidebar-state={layout.kind}
                style={{ width: `${displayWidth.toString()}px` }}
            >
                <div
                    {...sidebarAccessibility(sidebarOpen)}
                    className={cn(
                        "fixed inset-y-0 left-0 z-40 flex w-[min(320px,calc(100vw-20px))] flex-col overflow-hidden rounded-r-[20px] border-r-[0.5px] border-black/9 bg-sidebar shadow-[18px_0_56px_rgba(0,0,0,0.2)] transition-transform duration-200 ease-out motion-reduce:transition-none lg:static lg:h-full lg:w-full lg:translate-x-0 lg:rounded-none lg:shadow-none",
                        sidebarOpen ? "translate-x-0" : "-translate-x-[105%]",
                        layout.kind === "collapsed" && "lg:pointer-events-none lg:invisible",
                    )}
                    id="conversation-sidebar"
                    ref={sidebarRef}
                >
                    <div className="sidebar-safe-header flex items-center justify-between pr-3.5 pl-[18px]">
                        <Link
                            aria-label="Mobius agent chat home"
                            className="inline-flex min-h-11 items-center gap-2.5 text-base font-semibold tracking-[-0.02em] text-foreground no-underline lg:min-h-10"
                            onClick={closeSidebar}
                            to="/"
                        >
                            <MobiusMark />
                            <span>Mobius</span>
                        </Link>
                        <Button
                            aria-label="Close conversation sidebar"
                            className="size-11 lg:hidden"
                            onClick={closeSidebar}
                            ref={closeButtonRef}
                            size="icon"
                            variant="ghost"
                        >
                            <X className="size-[18px]" />
                        </Button>
                    </div>

                    <div className="px-3 pt-2 pb-3">
                        <Button
                            className="h-11 w-full justify-start rounded-[10px] border-black/9 bg-white px-2.5 text-[13px] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:bg-background lg:h-10"
                            disabled={agents.length === 0}
                            onClick={() => {
                                onCreateConversation();
                                closeSidebar();
                            }}
                            variant="outline"
                        >
                            <Plus className="size-[17px]" />
                            <span className="flex-1 text-left">New chat</span>
                            <kbd className="text-[11px] font-normal text-muted-foreground">⌘ N</kbd>
                        </Button>
                        {!managementPageOpen && <NativeSessionBrowser />}
                    </div>

                    <nav
                        aria-label="Conversations"
                        className="conversation-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3"
                    >
                        {runningConversations.length > 0 && (
                            <section aria-labelledby="running-conversations-heading">
                                <div className="flex min-h-8 items-center justify-between px-2.5 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                                    <h2 id="running-conversations-heading">Running</h2>
                                    <span>{runningConversations.length}</span>
                                </div>
                                <div className="grid gap-0.5">{runningConversations.map(conversationButton)}</div>
                            </section>
                        )}
                        <section
                            aria-labelledby="recent-conversations-heading"
                            className={cn(runningConversations.length > 0 && "mt-3")}
                        >
                            <div className="flex min-h-8 items-center justify-between px-2.5 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                                <h2 id="recent-conversations-heading">Recent</h2>
                                <span>{recentConversations.length}</span>
                            </div>
                            <div className="grid gap-0.5">{recentConversations.map(conversationButton)}</div>
                        </section>
                    </nav>

                    {!managementPageOpen && <AgentInstallationSidebarPanel />}

                    <nav aria-label="Channel navigation" className="border-t-[0.5px] border-black/6 px-3 py-2.5">
                        <NavLink
                            className={({ isActive }) =>
                                cn(
                                    "flex min-h-11 items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] font-medium text-foreground no-underline transition-colors duration-150 hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                                    isActive && "bg-black/8 hover:bg-black/8",
                                )
                            }
                            onClick={closeSidebar}
                            to={botsPath}
                        >
                            <span className="inline-flex size-7 items-center justify-center rounded-[8px] bg-white text-copy-secondary shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)]">
                                <Bot aria-hidden="true" className="size-3.5" />
                            </span>
                            Bots
                        </NavLink>
                        <NavLink
                            className={({ isActive }) =>
                                cn(
                                    "flex min-h-11 items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] font-medium text-foreground no-underline transition-colors duration-150 hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                                    isActive && "bg-black/8 hover:bg-black/8",
                                )
                            }
                            end
                            onClick={closeSidebar}
                            to={runtimesPath}
                        >
                            <span className="inline-flex size-7 items-center justify-center rounded-[8px] bg-white text-copy-secondary shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)]">
                                <Laptop aria-hidden="true" className="size-3.5" />
                            </span>
                            Local machines
                        </NavLink>
                        <NavLink
                            className={({ isActive }) =>
                                cn(
                                    "flex min-h-11 items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] font-medium text-foreground no-underline transition-colors duration-150 hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                                    isActive && "bg-black/8 hover:bg-black/8",
                                )
                            }
                            end
                            onClick={closeSidebar}
                            to={accessPath}
                        >
                            <span className="inline-flex size-7 items-center justify-center rounded-[8px] bg-white text-copy-secondary shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)]">
                                <Smartphone aria-hidden="true" className="size-3.5" />
                            </span>
                            Access from other devices
                        </NavLink>
                        <NavLink
                            className={({ isActive }) =>
                                cn(
                                    "flex min-h-11 items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] font-medium text-foreground no-underline transition-colors duration-150 hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                                    isActive && "bg-black/8 hover:bg-black/8",
                                )
                            }
                            end
                            onClick={closeSidebar}
                            to={settingsPath}
                        >
                            <span className="inline-flex size-7 items-center justify-center rounded-[8px] bg-white text-copy-secondary shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)]">
                                <Settings aria-hidden="true" className="size-3.5" />
                            </span>
                            Agent settings
                        </NavLink>
                    </nav>

                    <div className="sidebar-safe-footer flex min-h-[56px] items-center justify-between gap-3 border-t-[0.5px] border-black/6 px-4 py-2.5">
                        <strong className="min-w-0 flex-1 truncate text-xs leading-[18px] font-medium">
                            {machineName}
                        </strong>
                        <SidebarRuntimeStatus runtime={runtime} />
                    </div>
                </div>
                {layout.kind === "expanded" && (
                    <SidebarResizeHandle
                        onReset={() => onLayoutChange(resetSidebar())}
                        onResize={(width) => onLayoutChange(resizeSidebar(width))}
                        onResizeEnd={(width, previousWidth) =>
                            onLayoutChange(finishSidebarResize({ kind: "expanded", width: previousWidth }, width))
                        }
                        width={layout.width}
                    />
                )}
            </div>
        </>
    );
}
