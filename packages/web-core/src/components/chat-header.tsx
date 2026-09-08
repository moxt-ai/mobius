import { Menu, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OfflineRuntimeState, UnavailableRuntimeState } from "@/domain/chat";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

interface ChatHeaderProps {
    readonly desktopSidebarCollapsed: boolean;
    readonly onCreateConversation: () => void;
    readonly onToggleDesktopSidebar: () => void;
}

export function ChatHeader({ desktopSidebarCollapsed, onCreateConversation, onToggleDesktopSidebar }: ChatHeaderProps) {
    const conversation = useChatStore(selectActiveConversation);
    const runtime = useChatStore((state) => state.runtime);
    const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
    const sidebarOpen = useChatStore((state) => state.sidebarOpen);
    const unavailable = runtime instanceof OfflineRuntimeState || runtime instanceof UnavailableRuntimeState;

    return (
        <header className="chat-header z-10 flex shrink-0 items-center border-b-[0.5px] border-black/6 bg-background/92 px-2.5 supports-[backdrop-filter]:backdrop-blur-xl md:px-[18px]">
            <Button
                aria-controls="conversation-sidebar"
                aria-expanded={sidebarOpen}
                aria-label="Open conversation sidebar"
                className="mr-[7px] size-11 lg:hidden"
                id="conversation-sidebar-trigger"
                onClick={() => {
                    setSidebarOpen(true);
                }}
                size="icon"
                variant="ghost"
            >
                <Menu className="size-[18px]" />
            </Button>
            <Button
                aria-label={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                className="mr-2 hidden lg:inline-flex"
                onClick={onToggleDesktopSidebar}
                size="icon"
                title={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                variant="ghost"
            >
                {desktopSidebarCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </Button>
            <h1 className="min-w-0 truncate text-sm leading-5 font-semibold tracking-[-0.01em]">
                {conversation.title}
            </h1>
            <Button
                aria-label="New chat"
                className="ml-auto size-11 lg:hidden"
                onClick={onCreateConversation}
                size="icon"
                title="New chat"
                variant="ghost"
            >
                <Plus className="size-[18px]" />
            </Button>
            {unavailable && (
                <div
                    aria-live="polite"
                    className="ml-1.5 inline-flex min-h-8 items-center gap-[7px] rounded-full px-2 text-[11px] font-medium text-destructive"
                    role="status"
                >
                    <span
                        aria-hidden="true"
                        className="size-[7px] rounded-full bg-destructive shadow-[0_0_0_3px_color-mix(in_srgb,var(--destructive)_10%,transparent)]"
                    />
                    <span className="max-sm:hidden">{runtime.label}</span>
                    <span className="sr-only sm:hidden">{runtime.label}</span>
                </div>
            )}
        </header>
    );
}
