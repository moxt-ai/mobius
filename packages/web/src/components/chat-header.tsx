import { Menu } from "lucide-react";

import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import {
  OfflineRuntimeState,
  OnlineRuntimeState,
  UnavailableRuntimeState,
} from "@/domain/chat";
import { cn } from "@/lib/utils";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

export function ChatHeader() {
  const conversation = useChatStore(selectActiveConversation);
  const runtime = useChatStore((state) => state.runtime);
  const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
  const sidebarOpen = useChatStore((state) => state.sidebarOpen);
  const online = runtime instanceof OnlineRuntimeState;
  const unavailable =
    runtime instanceof OfflineRuntimeState ||
    runtime instanceof UnavailableRuntimeState;

  return (
    <header className="z-10 flex min-h-16 items-center border-b-[0.5px] border-black/6 bg-background/95 px-3 md:px-[22px]">
      <Button
        aria-controls="conversation-sidebar"
        aria-expanded={sidebarOpen}
        aria-label="Open conversation sidebar"
        className="mr-[7px] md:hidden"
        onClick={() => {
          setSidebarOpen(true);
        }}
        size="icon"
        variant="ghost"
      >
        <Menu className="size-[18px]" />
      </Button>
      <AgentAvatar compact />
      <div className="ml-[11px] min-w-0">
        <h1 className="truncate text-sm leading-5 font-semibold tracking-[-0.01em]">
          {conversation.title}
        </h1>
        <p className="mt-px truncate text-[11px] leading-[15px] text-muted-foreground max-[420px]:hidden">
          {conversation.agentLabel} <span aria-hidden="true">·</span> local
          workspace
        </p>
      </div>
      <div
        aria-live="polite"
        className={cn(
          "ml-auto inline-flex min-h-[30px] items-center gap-[7px] rounded-full border-[0.5px] border-black/9 bg-white px-2.5 text-[11px] font-medium text-[#454959]",
          unavailable && "text-[#b4232a]",
        )}
        role="status"
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-[7px] rounded-full bg-[#d49a2a] shadow-[0_0_0_3px_rgba(212,154,42,0.12)]",
            online && "bg-[#2fb872] shadow-[0_0_0_3px_rgba(47,184,114,0.12)]",
            unavailable &&
              "bg-[#e0525b] shadow-[0_0_0_3px_rgba(224,82,91,0.1)]",
          )}
        />
        <span className="max-sm:hidden">{runtime.label}</span>
        <span className="sr-only sm:hidden">{runtime.label}</span>
      </div>
    </header>
  );
}
