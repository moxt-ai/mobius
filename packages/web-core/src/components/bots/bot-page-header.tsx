import type { MobiusBot } from "@moxt-ai/mobius-sdk";
import { ArrowLeft, Bot, Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";

export function BotAvatar({ bot, className }: { readonly bot: MobiusBot; readonly className?: string }) {
    const initials = bot.displayName.trim().slice(0, 2).toUpperCase();
    return (
        <span
            aria-hidden="true"
            className={cn(
                "inline-flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-[#eaf8f0] text-sm font-semibold text-[#187747]",
                className,
            )}
        >
            {initials.length > 0 ? initials : <Bot className="size-4" />}
        </span>
    );
}

function statusLabel(bot: MobiusBot): string {
    if (bot.state.kind === "draft") {
        return "Draft";
    }
    if (bot.state.kind === "active") {
        return "Active";
    }
    if (bot.state.kind === "suspended") {
        return "Suspended";
    }
    if (bot.state.kind === "archived") {
        return "Archived";
    }
    return "Unknown";
}

export function BotStatusBadge({ bot }: { readonly bot: MobiusBot }) {
    return (
        <span
            className={cn(
                "inline-flex min-h-6 items-center rounded-full px-2.5 text-[11px] font-semibold",
                bot.state.kind === "active" && "bg-[#e8f8ef] text-[#187747]",
                bot.state.kind === "draft" && "bg-[#f1f3f5] text-[#59636e]",
                bot.state.kind === "suspended" && "bg-[#fff5e6] text-[#9a5b00]",
                bot.state.kind === "archived" && "bg-[#fff0f0] text-[#9b2c32]",
            )}
        >
            {statusLabel(bot)}
        </span>
    );
}

export function BotPageHeader({
    backLabel,
    backTo,
    desktopSidebarCollapsed,
    leading,
    onToggleDesktopSidebar,
    title,
}: {
    readonly backLabel?: string;
    readonly backTo?: string;
    readonly desktopSidebarCollapsed: boolean;
    readonly leading?: ReactNode;
    readonly onToggleDesktopSidebar: () => void;
    readonly title: string;
}) {
    const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
    const sidebarOpen = useChatStore((state) => state.sidebarOpen);

    return (
        <header className="chat-header z-10 flex shrink-0 items-center border-b-[0.5px] border-black/6 bg-background/92 px-2.5 supports-[backdrop-filter]:backdrop-blur-xl md:px-[18px]">
            <Button
                aria-controls="conversation-sidebar"
                aria-expanded={sidebarOpen}
                aria-label="Open conversation sidebar"
                className="mr-[7px] size-11 lg:hidden"
                id="conversation-sidebar-trigger"
                onClick={() => setSidebarOpen(true)}
                size="icon"
                variant="ghost"
            >
                <Menu aria-hidden="true" className="size-[18px]" />
            </Button>
            <Button
                aria-label={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                className="mr-2 hidden lg:inline-flex"
                onClick={onToggleDesktopSidebar}
                size="icon"
                title={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                variant="ghost"
            >
                {desktopSidebarCollapsed ? (
                    <PanelLeftOpen aria-hidden="true" className="size-4" />
                ) : (
                    <PanelLeftClose aria-hidden="true" className="size-4" />
                )}
            </Button>
            {leading ?? (
                <span className="inline-flex size-8 items-center justify-center rounded-[9px] bg-[#eefaf3] text-[#218854]">
                    <Bot aria-hidden="true" className="size-4" />
                </span>
            )}
            <h1 className="ml-2 min-w-0 truncate text-sm font-semibold tracking-[-0.01em]">{title}</h1>
            {backTo !== undefined && backLabel !== undefined && (
                <Link
                    className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground no-underline transition-colors duration-150 hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    to={backTo}
                >
                    <ArrowLeft aria-hidden="true" className="size-3.5" />
                    {backLabel}
                </Link>
            )}
        </header>
    );
}

export function BotInlineError({ children, id }: { readonly children: ReactNode; readonly id?: string }) {
    return (
        <p className="mt-2 text-xs leading-5 text-[#9b2c32]" id={id} role="alert">
            {children}
        </p>
    );
}

export const BOT_FIELD_CLASS =
    "min-h-11 w-full rounded-lg border border-black/12 bg-white px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-[#65b98b] focus-visible:ring-2 focus-visible:ring-[#bfe8d1] disabled:cursor-not-allowed disabled:bg-black/[0.025] disabled:opacity-65";

export const BOT_TEXTAREA_CLASS = `${BOT_FIELD_CLASS} min-h-28 resize-y py-2.5 leading-6`;
