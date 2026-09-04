import { Folder, LoaderCircle, MessageSquare, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

function MobiusMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-[25px] fill-none stroke-[#279a60] stroke-[2.2] [stroke-linecap:round] [stroke-linejoin:round]"
      viewBox="0 0 32 32"
    >
      <path d="M7 9.5C7 6.46 9.46 4 12.5 4S18 6.46 18 9.5 15.54 15 12.5 15H11" />
      <path d="M25 22.5c0 3.04-2.46 5.5-5.5 5.5S14 25.54 14 22.5s2.46-5.5 5.5-5.5H21" />
      <path d="M11 15h10M21 17H11" />
    </svg>
  );
}

export function ConversationSidebar() {
  const conversations = useChatStore((state) => state.conversations);
  const activeConversation = useChatStore(selectActiveConversation);
  const createConversation = useChatStore((state) => state.createConversation);
  const runtime = useChatStore((state) => state.runtime);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
  const sidebarOpen = useChatStore((state) => state.sidebarOpen);
  const workspaceName = useChatStore((state) => state.workspaceName);

  return (
    <>
      {sidebarOpen && (
        <button
          aria-label="Close conversation sidebar"
          className="fixed inset-0 z-20 bg-black/25 md:hidden"
          onClick={() => {
            setSidebarOpen(false);
          }}
          type="button"
        />
      )}
      <aside
        aria-label="Conversation sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-[min(288px,calc(100vw-52px))] flex-col border-r-[0.5px] border-black/9 bg-sidebar shadow-[18px_0_50px_rgba(0,0,0,0.12)] transition-transform duration-200 ease-out md:static md:w-auto md:translate-x-0 md:shadow-none",
          sidebarOpen ? "translate-x-0" : "-translate-x-[105%]",
        )}
        id="conversation-sidebar"
      >
        <div className="flex min-h-16 items-center justify-between pr-3.5 pl-[18px]">
          <a
            aria-label="Mobius agent chat home"
            className="inline-flex min-h-10 items-center gap-2.5 text-base font-semibold tracking-[-0.02em] text-foreground no-underline"
            href="/"
          >
            <MobiusMark />
            <span>Mobius</span>
          </a>
          <Button
            aria-label="Close conversation sidebar"
            className="md:hidden"
            onClick={() => {
              setSidebarOpen(false);
            }}
            size="icon"
            variant="ghost"
          >
            <X className="size-[18px]" />
          </Button>
        </div>

        <div className="px-3 pt-2 pb-[18px]">
          <Button
            className="h-10 w-full justify-start rounded-[10px] border-black/9 bg-white px-2.5 text-[13px] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:bg-[#fbfbfc]"
            onClick={createConversation}
            variant="outline"
          >
            <Plus className="size-[17px]" />
            <span className="flex-1 text-left">New chat</span>
            <kbd className="text-[11px] font-normal text-muted-foreground">
              ⌘ N
            </kbd>
          </Button>
        </div>

        <nav
          aria-label="Conversations"
          className="min-h-0 flex-1 overflow-hidden"
        >
          <div className="flex min-h-[31px] items-center justify-between px-[18px] text-[11px] font-semibold tracking-[0.02em] text-muted-foreground">
            <span>Conversations</span>
            <span>{conversations.length}</span>
          </div>
          <div className="conversation-scroll h-[calc(100%-31px)] overflow-y-auto px-2">
            {conversations.map((conversation) => {
              const active = conversation.id === activeConversation.id;
              return (
                <Button
                  aria-current={active}
                  className={cn(
                    "grid min-h-[58px] w-full grid-cols-[28px_minmax(0,1fr)] items-center rounded-[9px] px-2.5 py-2 text-left hover:bg-black/5",
                    active && "bg-black/8 hover:bg-black/8",
                  )}
                  key={conversation.id}
                  onClick={() => {
                    selectConversation(conversation.id);
                  }}
                  variant="ghost"
                >
                  <span className="inline-flex size-6 items-center justify-center rounded-[7px] bg-white text-[#454959] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)]">
                    {conversation.isRunning ? (
                      <LoaderCircle className="size-[13px] animate-spin text-[#279a60]" />
                    ) : (
                      <MessageSquare className="size-[13px]" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-[13px] leading-[19px] font-medium text-foreground">
                      {conversation.title}
                    </strong>
                    <span className="mt-px block truncate text-[11px] leading-4 font-normal text-muted-foreground">
                      {conversation.agentLabel} ·{" "}
                      {conversation.isRunning
                        ? conversation.activeStateLabel
                        : conversation.preview}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </nav>

        <div className="flex min-h-[70px] items-center gap-2.5 border-t-[0.5px] border-black/6 px-4 py-[13px]">
          <span className="inline-flex size-8 items-center justify-center rounded-[9px] bg-[#eefaf3] text-[#279a60]">
            <Folder className="size-[17px]" />
          </span>
          <span>
            <strong className="block text-xs leading-[18px] font-medium">
              {workspaceName}
            </strong>
            <span className="block text-[11px] leading-4 text-muted-foreground">
              {runtime.sidebarLabel}
            </span>
          </span>
        </div>
      </aside>
    </>
  );
}
