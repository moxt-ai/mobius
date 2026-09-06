import {
  type NativeSessionHistory,
  parseNativeHistoryText,
  SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
} from "@moxt-ai/mobius-web-sdk";
import { ArrowDown, MoreHorizontal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { AgentActivityList } from "@/components/agent-activity-list";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentMarkdown } from "@/components/agent-markdown";
import { AgentRichContent } from "@/components/agent-rich-content";
import { ChatComposer } from "@/components/chat-composer";
import { SessionInteractions } from "@/components/session-interactions";
import { Button } from "@/components/ui/button";
import {
  AgentChatMessage,
  type ChatMessage,
  NativeHistoryChatMessage,
  UserChatMessage,
} from "@/domain/chat";
import { cn } from "@/lib/utils";
import { sendPrompt } from "@/services/mobius-transport";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

const SCROLL_TAIL_THRESHOLD = 96;
const SAFE_IMAGE_MIME = /^image\/(?:gif|jpeg|png|webp)$/;
const suggestions = [
  "Explain the current project structure",
  "Find the entry point for this workspace",
  "Summarize how the relay path works",
];

function EmptyConversation() {
  const conversation = useChatStore(selectActiveConversation);
  const runtime = useChatStore((state) => state.runtime);

  return (
    <section
      aria-labelledby="empty-title"
      className="empty-conversation mx-auto mt-[clamp(42px,10vh,92px)] mb-10 w-[min(840px,calc(100%-40px))] text-center max-md:mt-[clamp(24px,6vh,52px)] max-md:w-[min(620px,calc(100%-24px))]"
    >
      <div className="empty-conversation-avatar mx-auto mb-[13px] w-fit">
        <AgentAvatar floating />
      </div>
      <p className="m-0 text-xs font-semibold text-success">
        {conversation.agentLabel} on your machine
      </p>
      <h2
        className="mt-[7px] text-[clamp(23px,3vw,28px)] leading-[1.3] font-semibold tracking-[-0.03em] text-foreground max-[420px]:text-[22px]"
        id="empty-title"
      >
        What can I help you work on?
      </h2>
      <p className="empty-conversation-description mx-auto mt-2 max-w-[520px] text-sm leading-[22px] text-copy-secondary max-md:max-w-[420px] max-md:text-[13px] max-md:leading-5">
        Plan, inspect, and make changes in your conversation’s working
        directory.
      </p>
      <ChatComposer placement="idle" />
      <fieldset className="empty-conversation-suggestions mx-auto mt-4 grid max-w-[720px] grid-cols-3 gap-2 border-0 p-0 text-left max-md:grid-cols-1 max-md:gap-1.5">
        <legend className="sr-only">Suggested prompts</legend>
        {suggestions.map((prompt) => (
          <Button
            className="group min-h-14 items-center whitespace-normal rounded-xl border-black/9 bg-white px-3 py-2.5 text-left text-xs leading-[18px] font-normal text-copy-secondary motion-safe:hover:-translate-y-px hover:border-black/12 hover:bg-background hover:text-foreground max-md:min-h-11"
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
              className="mt-px text-muted-foreground transition-transform duration-150 motion-reduce:transition-none group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0"
            >
              →
            </span>
          </Button>
        ))}
      </fieldset>
    </section>
  );
}

function UserMessage({
  message,
}: {
  readonly message: Pick<UserChatMessage, "text" | "images" | "resources">;
}) {
  return (
    <article
      aria-label="Message from you"
      className="mb-4 flex justify-end motion-safe:animate-[message-enter_200ms_ease-out_both]"
    >
      <div className="min-w-0 max-w-[85%] max-md:max-w-[92%]">
        <div className="grid min-w-0 gap-2 rounded-md bg-black/[0.05] px-4 py-3 text-[15px] leading-6 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
          {message.images.length > 0 && (
            <div
              className={cn(
                "grid min-w-0 gap-1.5",
                message.images.length > 1 && "grid-cols-2",
              )}
            >
              {message.images.map((image, index) =>
                SAFE_IMAGE_MIME.test(image.mimeType) ? (
                  <img
                    alt={image.name}
                    className="h-auto max-h-56 max-w-full rounded-lg object-contain object-left"
                    key={`${index.toString()}:${image.name}`}
                    loading="lazy"
                    src={`data:${image.mimeType};base64,${image.data}`}
                  />
                ) : (
                  <span
                    className="rounded-lg border-[0.5px] border-black/9 bg-white/70 p-2 text-[10px] text-muted-foreground"
                    key={`${index.toString()}:${image.name}`}
                  >
                    {image.name}
                  </span>
                ),
              )}
            </div>
          )}
          {message.resources.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {message.resources.map((resource) => (
                <span
                  className="rounded-md border-[0.5px] border-black/10 bg-white/70 px-2 py-1 font-mono text-[10px]"
                  key={`${resource.uri}:${resource.name}`}
                >
                  {resource.name}
                </span>
              ))}
            </div>
          )}
          {message.text.length > 0 && <span>{message.text}</span>}
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
      className="mb-12 min-w-0 motion-safe:animate-[message-enter_200ms_ease-out_both]"
    >
      <div className="min-w-0">
        <AgentActivityList
          activities={message.activities}
          streaming={message.state.isStreaming}
        />
        {message.text.length > 0 && (
          <div
            className={cn(
              "agent-stream",
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
        <AgentRichContent
          contents={message.contents.map((entry) => entry.content)}
        />
        <div className="mt-3 flex min-h-8 items-center gap-1.5">
          {message.state.appearance !== "completed" && (
            <span
              className={cn(
                "turn-status inline-flex w-fit items-center gap-[5px] rounded-md bg-black/[0.045] px-2 py-1 text-[11px] leading-4 text-muted-foreground",
                message.state.appearance === "working" && "text-warning",
                message.state.appearance === "failed" && "text-destructive",
              )}
              data-state={message.state.appearance}
            >
              {message.state.label}
            </span>
          )}
          <details className="group/turn-details max-w-full text-[11px] text-muted-foreground">
            <summary
              aria-label="Show run details"
              className="flex size-11 cursor-pointer list-none items-center justify-center rounded-full outline-none select-none hover:bg-black/[0.045] hover:text-copy-secondary focus-visible:ring-2 focus-visible:ring-ring/70 md:size-8"
              title="Run details"
            >
              <MoreHorizontal className="size-4" />
            </summary>
            <div className="mt-1.5 rounded-lg border-[0.5px] border-black/8 bg-surface-subtle p-3">
              <p className="mb-2 text-[10px] font-semibold tracking-[0.06em] text-copy-tertiary uppercase">
                Run details
              </p>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 leading-[17px]">
                {message.state.details(sessionId).map((detail) => (
                  <div className="contents" key={detail.label}>
                    <dt>{detail.label}</dt>
                    <dd
                      className="m-0 min-w-0 truncate font-mono text-copy-secondary"
                      title={detail.value}
                    >
                      {detail.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </details>
        </div>
      </div>
    </article>
  );
}

export function NativeSessionHistoryView({
  history,
  agentLabel,
}: {
  readonly history: NativeSessionHistory;
  readonly agentLabel: string;
}) {
  if (history.status === "unavailable")
    return (
      <p
        className="mb-5 text-center text-xs text-muted-foreground"
        role="status"
      >
        This Agent restores context but does not provide message history.
      </p>
    );
  const messages = history.messages.slice(
    -SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
  );
  const truncated =
    history.truncated || messages.length < history.messages.length;
  return (
    <section aria-label="Previous conversation history">
      <p className="mb-5 text-center text-xs text-muted-foreground">
        {truncated
          ? `Showing the last ${messages.length.toString()} messages. Earlier history is not shown.`
          : "Previous conversation from the Agent"}
      </p>
      {messages.map((entry, index) => {
        const parsed = parseNativeHistoryText(entry.text);
        return entry.role === "user" ? (
          <UserMessage
            key={index.toString()}
            message={{
              text: parsed.text,
              images: [...(entry.images ?? []), ...parsed.images],
              resources: [],
            }}
          />
        ) : (
          <article
            aria-label={`Previous message from ${agentLabel}`}
            className="mb-6 text-[15px] leading-6"
            key={index.toString()}
          >
            <AgentMarkdown markdown={entry.text} streaming={false} />
          </article>
        );
      })}
    </section>
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
  if (message instanceof NativeHistoryChatMessage) {
    return (
      <NativeSessionHistoryView
        history={message.history}
        agentLabel={agentLabel}
      />
    );
  }
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
            className="mx-auto min-h-full w-full max-w-[840px] px-6 pt-10 pb-16 max-md:px-4 max-md:pt-7"
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
            <SessionInteractions />
          </div>
        )}
      </div>
      {showLatest && conversation.messages.length > 0 && (
        <Button
          className="absolute right-6 bottom-3 h-[34px] rounded-full border-black/9 bg-white px-[11px] text-[11px] font-medium text-[#454959] shadow-[0_4px_14px_rgba(0,0,0,0.08)] hover:bg-[#fcfcfd] max-md:right-3.5 max-md:h-11"
          onClick={() => {
            const viewport = viewportRef.current;
            if (viewport !== null) {
              viewport.scrollTo({
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                  .matches
                  ? "auto"
                  : "smooth",
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
