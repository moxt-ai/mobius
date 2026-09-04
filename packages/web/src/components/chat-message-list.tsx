import { ArrowDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { AgentActivityList } from "@/components/agent-activity-list";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentMarkdown } from "@/components/agent-markdown";
import { Button } from "@/components/ui/button";
import {
  AgentChatMessage,
  type ChatMessage,
  UserChatMessage,
} from "@/domain/chat";
import { cn } from "@/lib/utils";
import { sendPrompt } from "@/services/mobius-transport";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

const SCROLL_TAIL_THRESHOLD = 96;
const suggestions = [
  "Explain the current project structure",
  "Find the entry point for this workspace",
  "Summarize how the relay path works",
];

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function EmptyConversation() {
  const conversation = useChatStore(selectActiveConversation);
  const runtime = useChatStore((state) => state.runtime);

  return (
    <section
      aria-labelledby="empty-title"
      className="empty-conversation mx-auto mt-[clamp(56px,12vh,116px)] mb-10 w-[min(720px,calc(100%-40px))] text-center max-md:mt-[clamp(36px,8vh,72px)] max-md:w-[min(620px,calc(100%-28px))]"
    >
      <div className="empty-conversation-avatar mx-auto mb-[13px] w-fit">
        <AgentAvatar floating />
      </div>
      <p className="m-0 text-xs font-semibold text-[#279a60]">
        {conversation.agentLabel} on your machine
      </p>
      <h2
        className="mt-[7px] text-[clamp(23px,3vw,28px)] leading-[1.3] font-semibold tracking-[-0.03em] text-foreground max-[420px]:text-[22px]"
        id="empty-title"
      >
        What can I help you work on?
      </h2>
      <p className="empty-conversation-description mx-auto mt-3 max-w-[560px] text-sm leading-[22px] text-[#454959] max-md:max-w-[440px] max-md:text-[13px] max-md:leading-5">
        Messages travel through the Mobius relay to the authorized local
        workspace, then stream back into this conversation.
      </p>
      <fieldset className="empty-conversation-suggestions mx-auto mt-[30px] grid max-w-[620px] grid-cols-3 gap-[9px] border-0 p-0 text-left max-md:grid-cols-1 max-md:gap-[7px]">
        <legend className="sr-only">Suggested prompts</legend>
        {suggestions.map((prompt) => (
          <Button
            className="group min-h-[84px] items-start whitespace-normal rounded-xl border-black/9 bg-white px-[13px] py-3 text-left text-xs leading-[18px] font-normal text-[#454959] hover:-translate-y-px hover:border-black/12 hover:bg-[#fcfcfd] hover:text-foreground max-md:min-h-12 max-md:items-center"
            disabled={!runtime.canSend || conversation.isRunning}
            key={prompt}
            onClick={() => {
              void sendPrompt(prompt);
            }}
            variant="outline"
          >
            <span className="flex-1">{prompt}</span>
            <span
              aria-hidden="true"
              className="mt-px text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5"
            >
              →
            </span>
          </Button>
        ))}
      </fieldset>
    </section>
  );
}

function UserMessage({ message }: { readonly message: UserChatMessage }) {
  return (
    <article
      aria-label="Message from you"
      className="mb-[30px] flex justify-end motion-safe:animate-[message-enter_200ms_ease-out_both]"
    >
      <div className="max-w-[min(72%,620px)] max-md:max-w-[88%]">
        <p className="mx-0.5 mb-1.5 text-right text-[11px] leading-4 font-medium text-muted-foreground">
          You · {timeFormatter.format(message.createdAt)}
        </p>
        <div className="overflow-wrap-anywhere rounded-[15px_15px_4px_15px] border-[0.5px] border-black/6 bg-black/5 px-[13px] py-2.5 text-sm leading-[22px] whitespace-pre-wrap text-foreground">
          {message.text}
        </div>
      </div>
    </article>
  );
}

function ThinkingIndicator() {
  return (
    <div
      aria-label="Agent is working"
      className="thinking-indicator mt-1.5 inline-flex h-6 items-center gap-1"
      role="status"
    >
      <span />
      <span />
      <span />
    </div>
  );
}

function AgentMessage({
  agentLabel,
  message,
  sessionId,
}: {
  readonly agentLabel: string;
  readonly message: AgentChatMessage;
  readonly sessionId: string;
}) {
  return (
    <article
      aria-label={`Message from ${agentLabel}`}
      className="mb-[38px] grid grid-cols-[30px_minmax(0,1fr)] gap-[11px] motion-safe:animate-[message-enter_200ms_ease-out_both] max-[420px]:grid-cols-[27px_minmax(0,1fr)] max-[420px]:gap-[9px]"
    >
      <div className="mt-px scale-[0.875] origin-top-left">
        <AgentAvatar compact />
      </div>
      <div className="min-w-0">
        <div className="flex min-h-[22px] items-center gap-2">
          <p className="m-0 text-xs leading-4 font-semibold text-[#454959]">
            {agentLabel}
          </p>
          <span
            className={cn(
              "turn-status inline-flex items-center gap-[5px] text-[11px] leading-4 text-muted-foreground",
              message.state.appearance === "working" && "text-[#9a6700]",
              message.state.appearance === "completed" && "text-[#279a60]",
              message.state.appearance === "failed" && "text-[#b4232a]",
            )}
            data-state={message.state.appearance}
          >
            {message.state.label}
          </span>
        </div>
        {message.text.length > 0 && (
          <div
            className={cn(
              "agent-stream mt-[7px]",
              message.state.isStreaming && "is-streaming",
            )}
          >
            <AgentMarkdown
              markdown={message.text}
              streaming={message.state.isStreaming}
            />
          </div>
        )}
        {message.text.length === 0 &&
          message.state.isStreaming &&
          message.activities.length === 0 && <ThinkingIndicator />}
        <AgentActivityList
          activities={message.activities}
          streaming={message.state.isStreaming}
        />
        <details className="mt-[9px] w-fit max-w-full text-[11px] text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded-sm outline-none hover:text-[#454959] focus-visible:ring-2 focus-visible:ring-[#2fb872]/35">
            Run details
          </summary>
          <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 leading-[17px]">
            {message.state.details(sessionId).map((detail) => (
              <div className="contents" key={detail.label}>
                <dt>{detail.label}</dt>
                <dd
                  className="m-0 min-w-0 truncate font-mono text-[#454959]"
                  title={detail.value}
                >
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </article>
  );
}

function Message({
  agentLabel,
  message,
  sessionId,
}: {
  readonly agentLabel: string;
  readonly message: ChatMessage;
  readonly sessionId: string;
}) {
  if (message instanceof UserChatMessage) {
    return <UserMessage message={message} />;
  }
  if (message instanceof AgentChatMessage) {
    return (
      <AgentMessage
        agentLabel={agentLabel}
        message={message}
        sessionId={sessionId}
      />
    );
  }
  return null;
}

export function ChatMessageList() {
  const conversation = useChatStore(selectActiveConversation);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const previousConversationIdRef = useRef(conversation.id);
  const [showLatest, setShowLatest] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    if (previousConversationIdRef.current !== conversation.id) {
      previousConversationIdRef.current = conversation.id;
      followLatestRef.current = true;
    }
    if (followLatestRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      setShowLatest(false);
    }
  });

  return (
    <div className="relative min-h-0 flex-1">
      <div
        className="conversation-scroll h-full overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const viewport = event.currentTarget;
          const remaining =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
          followLatestRef.current = remaining <= SCROLL_TAIL_THRESHOLD;
          setShowLatest(!followLatestRef.current);
        }}
        ref={viewportRef}
      >
        {conversation.messages.length === 0 ? (
          <EmptyConversation />
        ) : (
          <div
            aria-busy={conversation.isRunning}
            aria-live="polite"
            aria-relevant="additions text"
            className="mx-auto min-h-full w-full max-w-[860px] px-8 pt-[46px] pb-10 max-md:px-4 max-md:pt-[30px] max-md:pb-7"
            role="log"
          >
            {conversation.messages.map((message) => (
              <Message
                agentLabel={conversation.agentLabel}
                key={message.id}
                message={message}
                sessionId={conversation.sessionId}
              />
            ))}
          </div>
        )}
      </div>
      {showLatest && conversation.messages.length > 0 && (
        <Button
          className="absolute right-6 bottom-3 h-[34px] rounded-full border-black/9 bg-white px-[11px] text-[11px] font-medium text-[#454959] shadow-[0_4px_14px_rgba(0,0,0,0.08)] hover:bg-[#fcfcfd] max-md:right-3.5 max-md:h-[38px]"
          onClick={() => {
            const viewport = viewportRef.current;
            if (viewport !== null) {
              viewport.scrollTo({
                behavior: "smooth",
                top: viewport.scrollHeight,
              });
              followLatestRef.current = true;
              setShowLatest(false);
            }
          }}
          variant="outline"
        >
          <ArrowDown className="size-3.5" />
          Latest
        </Button>
      )}
    </div>
  );
}
