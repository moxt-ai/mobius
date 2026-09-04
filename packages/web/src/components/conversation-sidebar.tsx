import { LoaderCircle, MessageSquare, Plus, X } from "lucide-react";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { SidebarRuntimeStatus } from "@/components/sidebar-runtime-status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type DesktopSidebarLayoutState,
  finishSidebarResize,
  resetSidebar,
  resizeSidebar,
  sidebarDisplayWidth,
} from "@/services/workspace-layout";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

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
  readonly layout: DesktopSidebarLayoutState;
  readonly onLayoutChange: (layout: DesktopSidebarLayoutState) => void;
}

export function ConversationSidebar({
  layout,
  onLayoutChange,
}: ConversationSidebarProps) {
  const conversations = useChatStore((state) => state.conversations);
  const activeConversation = useChatStore(selectActiveConversation);
  const createConversation = useChatStore((state) => state.createConversation);
  const runtime = useChatStore((state) => state.runtime);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
  const sidebarOpen = useChatStore((state) => state.sidebarOpen);
  const workspaceName = useChatStore((state) => state.workspaceName);
  const runningConversations = conversations.filter(
    (conversation) => conversation.isRunning,
  );
  const recentConversations = conversations.filter(
    (conversation) => !conversation.isRunning,
  );
  const displayWidth = sidebarDisplayWidth(layout);

  const conversationButton = (conversation: (typeof conversations)[number]) => {
    const active = conversation.id === activeConversation.id;
    return (
      <Button
        aria-current={active ? "page" : undefined}
        className={cn(
          "grid min-h-11 w-full grid-cols-[24px_minmax(0,1fr)] items-center rounded-[9px] px-2.5 py-1.5 text-left hover:bg-black/5",
          active && "bg-black/8 hover:bg-black/8",
        )}
        key={conversation.id}
        onClick={() => {
          selectConversation(conversation.id);
        }}
        variant="ghost"
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
            {conversation.isRunning
              ? conversation.activeStateLabel
              : conversation.preview}
          </span>
        </span>
      </Button>
    );
  };

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
      <div
        className={cn(
          "contents md:relative md:block md:h-full md:shrink-0",
          layout.kind === "collapsed" && "md:w-0",
        )}
        data-sidebar-state={layout.kind}
        style={{ width: `${displayWidth.toString()}px` }}
      >
        <aside
          aria-label="Conversation sidebar"
          className={cn(
            "fixed inset-y-0 left-0 z-30 flex w-[min(288px,calc(100vw-52px))] flex-col overflow-hidden border-r-[0.5px] border-black/9 bg-sidebar shadow-[18px_0_50px_rgba(0,0,0,0.12)] transition-transform duration-200 ease-out motion-reduce:transition-none md:static md:h-full md:w-full md:translate-x-0 md:shadow-none",
            sidebarOpen ? "translate-x-0" : "-translate-x-[105%]",
            layout.kind === "collapsed" &&
              "md:pointer-events-none md:invisible",
          )}
          id="conversation-sidebar"
        >
          <div className="flex min-h-16 items-center justify-between pr-3.5 pl-[18px]">
            <a
              aria-label="Mobius agent chat home"
              className="inline-flex min-h-11 items-center gap-2.5 text-base font-semibold tracking-[-0.02em] text-foreground no-underline md:min-h-10"
              href="/"
            >
              <MobiusMark />
              <span>Mobius</span>
            </a>
            <Button
              aria-label="Close conversation sidebar"
              className="size-11 md:hidden"
              onClick={() => {
                setSidebarOpen(false);
              }}
              size="icon"
              variant="ghost"
            >
              <X className="size-[18px]" />
            </Button>
          </div>

          <div className="px-3 pt-2 pb-3">
            <Button
              className="h-11 w-full justify-start rounded-[10px] border-black/9 bg-white px-2.5 text-[13px] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:bg-background md:h-10"
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
            className="conversation-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          >
            {runningConversations.length > 0 && (
              <section aria-labelledby="running-conversations-heading">
                <div className="flex min-h-8 items-center justify-between px-2.5 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  <h2 id="running-conversations-heading">Running</h2>
                  <span>{runningConversations.length}</span>
                </div>
                <div className="grid gap-0.5">
                  {runningConversations.map(conversationButton)}
                </div>
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
              <div className="grid gap-0.5">
                {recentConversations.map(conversationButton)}
              </div>
            </section>
          </nav>

          <div className="flex min-h-[56px] items-center justify-between gap-3 border-t-[0.5px] border-black/6 px-4 py-2.5">
            <strong className="min-w-0 flex-1 truncate text-xs leading-[18px] font-medium">
              {workspaceName}
            </strong>
            <SidebarRuntimeStatus runtime={runtime} />
          </div>
        </aside>
        {layout.kind === "expanded" && (
          <SidebarResizeHandle
            onReset={() => onLayoutChange(resetSidebar())}
            onResize={(width) => onLayoutChange(resizeSidebar(width))}
            onResizeEnd={(width, previousWidth) =>
              onLayoutChange(
                finishSidebarResize(
                  { kind: "expanded", width: previousWidth },
                  width,
                ),
              )
            }
            width={layout.width}
          />
        )}
      </div>
    </>
  );
}
