import { Menu, Plus, Slash } from "lucide-react";

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
  const createConversation = useChatStore((state) => state.createConversation);
  const runtime = useChatStore((state) => state.runtime);
  const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
  const sidebarOpen = useChatStore((state) => state.sidebarOpen);
  const online = runtime instanceof OnlineRuntimeState;
  const unavailable =
    runtime instanceof OfflineRuntimeState ||
    runtime instanceof UnavailableRuntimeState;

  return (
    <header className="z-10 flex min-h-14 items-center border-b-[0.5px] border-black/6 bg-background/95 px-3 md:px-[18px]">
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
      <strong className="ml-2 truncate text-sm leading-5 font-semibold tracking-[-0.01em]">
        {conversation.agentLabel}
      </strong>
      <Slash
        aria-hidden="true"
        className="mx-1 size-3 shrink-0 -rotate-12 text-black/20"
      />
      <h1 className="min-w-0 truncate text-sm leading-5 font-semibold tracking-[-0.01em]">
        {conversation.title}
      </h1>
      <Button
        aria-label="New chat"
        className="ml-auto"
        onClick={createConversation}
        size="icon"
        title="New chat"
        variant="ghost"
      >
        <Plus className="size-4" />
      </Button>
      <div
        aria-live="polite"
        className={cn(
          "ml-1.5 inline-flex min-h-8 items-center gap-[7px] rounded-full px-2 text-[11px] font-medium text-[#737b89] hover:bg-black/[0.035]",
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
