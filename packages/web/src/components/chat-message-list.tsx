import {
    type NativeSessionHistory,
    parseNativeHistoryText,
    SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
} from "@moxt-ai/mobius-sdk";
import { ArrowDown, GitFork, LoaderCircle, MoreHorizontal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AgentActivityList } from "@/components/agent-activity-list";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentMarkdown } from "@/components/agent-markdown";
import { AgentRichContent } from "@/components/agent-rich-content";
import { ChatComposer } from "@/components/chat-composer";
import { SessionInteractions } from "@/components/session-interactions";
import { Button } from "@/components/ui/button";
import { UserPromptMessage } from "@/components/user-prompt-message";
import { useWorkspaceRoutes } from "@/components/workspace-route-provider";
import type { ChannelConnection } from "@/domain/channel";
import { AgentChatMessage, type ChatMessage, NativeHistoryChatMessage, UserChatMessage } from "@/domain/chat";
import { cn } from "@/lib/utils";
import { forkConversationAtTurn, sendPrompt } from "@/services/mobius-transport";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

const SCROLL_TAIL_THRESHOLD = 96;
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
            className="empty-conversation mx-auto mt-[clamp(42px,10vh,92px)] mb-10 w-[min(840px,calc(100%-40px))] text-center max-md:mt-[clamp(24px,6vh,52px)] max-md:w-[min(620px,calc(100%-24px))] max-[420px]:mt-[clamp(22px,5vh,40px)]"
        >
            <div className="empty-conversation-avatar mx-auto mb-3 w-fit">
                <AgentAvatar className="max-[420px]:size-14" floating />
            </div>
            <p className="m-0 text-xs leading-[18px] font-semibold text-success max-[360px]:text-[11px] max-[360px]:leading-4">
                {conversation.agentLabel} on your machine
            </p>
            <h2
                className="mt-1.5 text-[clamp(22px,3vw,28px)] leading-[1.28] font-semibold tracking-[-0.025em] text-foreground max-[360px]:text-xl max-[360px]:leading-[1.25]"
                id="empty-title"
            >
                What can I help you work on?
            </h2>
            <p className="empty-conversation-description mx-auto mt-2 max-w-[520px] text-sm leading-[22px] text-copy-secondary max-md:max-w-[420px] max-md:text-[13px] max-md:leading-5 max-[360px]:px-1">
                Plan, inspect, and make changes in your conversation’s working directory.
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
    connection,
    conversationRunning,
    message,
    sessionId,
    supportsFork,
}: {
    readonly agentLabel: string;
    readonly connection: ChannelConnection;
    readonly conversationRunning: boolean;
    readonly message: AgentChatMessage;
    readonly sessionId: string;
    readonly supportsFork: boolean;
}) {
    const [forking, setForking] = useState(false);
    const navigate = useNavigate();
    const routes = useWorkspaceRoutes();
    const showFork = supportsFork && message.state.appearance === "completed";

    return (
        <article
            aria-label={`Message from ${agentLabel}`}
            className="mb-8 min-w-0 motion-safe:animate-[message-enter_200ms_ease-out_both] md:mb-12"
        >
            <div className="min-w-0">
                <AgentActivityList
                    activities={message.activities}
                    connection={connection}
                    sessionId={sessionId}
                    streaming={message.state.isStreaming}
                />
                {message.text.length > 0 && (
                    <div className={cn("agent-stream", message.state.isStreaming && "is-streaming")}>
                        <AgentMarkdown markdown={message.text} streaming={message.state.isStreaming} />
                    </div>
                )}
                {message.text.length === 0 && message.state.isStreaming && message.activities.length === 0 && (
                    <ThinkingIndicator />
                )}
                <AgentRichContent
                    connection={connection}
                    contents={message.contents.map((entry) => entry.content)}
                    sessionId={sessionId}
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
                            className="flex size-11 cursor-pointer list-none items-center justify-center rounded-full outline-none select-none hover:bg-black/[0.045] hover:text-copy-secondary focus-visible:ring-2 focus-visible:ring-ring/70 lg:size-8"
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
                    {showFork && (
                        <Button
                            aria-label={forking ? "Forking conversation" : "Fork conversation after this turn"}
                            className="size-11 rounded-full text-muted-foreground hover:bg-black/[0.045] hover:text-copy-secondary lg:size-8"
                            disabled={conversationRunning || forking}
                            onClick={() => {
                                setForking(true);
                                void forkConversationAtTurn(message.commandId)
                                    .then(async (targetSessionId) => {
                                        if (targetSessionId.length > 0) {
                                            await navigate(routes.sessionPath(targetSessionId));
                                        }
                                    })
                                    .finally(() => setForking(false));
                            }}
                            size="icon"
                            title={
                                conversationRunning
                                    ? "Wait for the running turn to finish"
                                    : "Fork conversation after this turn"
                            }
                            variant="ghost"
                        >
                            {forking ? (
                                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                            ) : (
                                <GitFork className="size-4" />
                            )}
                        </Button>
                    )}
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
    if (history.status === "unavailable") {
        return (
            <p className="mb-5 text-center text-xs text-muted-foreground" role="status">
                This Agent restores context but does not provide message history.
            </p>
        );
    }
    const messages = history.messages.slice(-SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT);
    const truncated = history.truncated || messages.length < history.messages.length;
    return (
        <section aria-label="Previous conversation history">
            <p className="mb-5 text-center text-xs text-muted-foreground">
                {truncated
                    ? `Showing the last ${messages.length.toString()} messages. Earlier history is not shown.`
                    : "Previous conversation from the Agent"}
            </p>
            {messages.map((entry, index) => {
                const parsed = parseNativeHistoryText(entry.text);
                const images = [...(entry.images ?? []), ...parsed.images];
                return entry.role === "user" ? (
                    <UserPromptMessage key={index.toString()} images={images} resources={[]} text={parsed.text} />
                ) : (
                    <article
                        aria-label={`Previous message from ${agentLabel}`}
                        className="mb-6 text-[15px] leading-6"
                        key={index.toString()}
                    >
                        {images.length > 0 && (
                            <div className="mb-2 grid min-w-0 gap-1.5">
                                {images.map((image, imageIndex) => (
                                    <img
                                        alt={image.name}
                                        className="h-auto max-h-56 max-w-full rounded-lg object-contain object-left"
                                        key={`${imageIndex.toString()}:${image.name}`}
                                        loading="lazy"
                                        src={`data:${image.mimeType};base64,${image.data}`}
                                    />
                                ))}
                            </div>
                        )}
                        {parsed.text.length > 0 && <AgentMarkdown markdown={parsed.text} streaming={false} />}
                    </article>
                );
            })}
        </section>
    );
}

function Message({
    agentLabel,
    connection,
    conversationRunning,
    message,
    sessionId,
    supportsFork,
}: {
    readonly agentLabel: string;
    readonly connection: ChannelConnection;
    readonly conversationRunning: boolean;
    readonly message: ChatMessage;
    readonly sessionId: string;
    readonly supportsFork: boolean;
}) {
    if (message instanceof NativeHistoryChatMessage) {
        return <NativeSessionHistoryView history={message.history} agentLabel={agentLabel} />;
    }
    if (message instanceof UserChatMessage) {
        return <UserPromptMessage images={message.images} resources={message.resources} text={message.text} />;
    }
    if (message instanceof AgentChatMessage) {
        return (
            <AgentMessage
                agentLabel={agentLabel}
                connection={connection}
                conversationRunning={conversationRunning}
                message={message}
                sessionId={sessionId}
                supportsFork={supportsFork}
            />
        );
    }
    return null;
}

export function ChatMessageList({ connection }: { readonly connection: ChannelConnection }) {
    const conversation = useChatStore(selectActiveConversation);
    const messages = conversation.transcriptMessages;
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
        if (messages.length === 0) {
            viewport.scrollTop = 0;
            setShowLatest(false);
            return;
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
                    const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
                    followLatestRef.current = remaining <= SCROLL_TAIL_THRESHOLD;
                    setShowLatest(!followLatestRef.current);
                }}
                ref={viewportRef}
            >
                {messages.length === 0 ? (
                    <EmptyConversation />
                ) : (
                    <div
                        aria-busy={conversation.isRunning}
                        aria-live="polite"
                        aria-relevant="additions text"
                        className="mx-auto min-h-full w-full max-w-[840px] px-3.5 pt-5 pb-12 sm:px-5 sm:pt-7 md:px-6 md:pt-10 md:pb-16"
                        role="log"
                    >
                        {messages.map((message) => (
                            <Message
                                agentLabel={conversation.agentLabel}
                                connection={connection}
                                conversationRunning={conversation.isRunning}
                                key={message.id}
                                message={message}
                                sessionId={conversation.sessionId}
                                supportsFork={conversation.session.capabilities.unstableForkSession}
                            />
                        ))}
                        <SessionInteractions />
                    </div>
                )}
            </div>
            {showLatest && messages.length > 0 && (
                <Button
                    aria-label="Scroll to latest message"
                    className="absolute bottom-3 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full border-border/70 bg-background/95 p-0 text-foreground shadow-[0_4px_14px_rgba(0,0,0,0.1)] backdrop-blur-sm hover:bg-accent max-lg:size-11"
                    onClick={() => {
                        const viewport = viewportRef.current;
                        if (viewport !== null) {
                            viewport.scrollTo({
                                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                                    ? "auto"
                                    : "smooth",
                                top: viewport.scrollHeight,
                            });
                            followLatestRef.current = true;
                            setShowLatest(false);
                        }
                    }}
                    size="icon"
                    title="Scroll to latest message"
                    variant="outline"
                >
                    <ArrowDown className="size-4" />
                </Button>
            )}
        </div>
    );
}
