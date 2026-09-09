import {
    conversationTitleFromText,
    MobiusApiError,
    MobiusBotConversation,
    type MobiusBotConversationEvent,
    type MobiusMessage,
    type MobiusSession,
    type PromptImage,
    type PromptResource,
    type SessionConfigOption,
    type SessionReadyEvent,
    type WorkspaceEntry,
} from "@moxt-ai/mobius-sdk";
import {
    ArrowLeft,
    Bot,
    FileText,
    Image as ImageIcon,
    LoaderCircle,
    LockKeyhole,
    MessageSquare,
    Paperclip,
    Plus,
    RefreshCw,
    Send,
    Square,
    X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";

import { AgentMarkdown } from "@/components/agent-markdown";
import { BotInlineError } from "@/components/bots/bot-page-header";
import type { BotDetailContext } from "@/components/bots/bot-workspace";
import { SessionConfigControlsView } from "@/components/session-config-controls";
import { Button } from "@/components/ui/button";
import { UserPromptMessage } from "@/components/user-prompt-message";
import { WorkspacePickerControl } from "@/components/workspace-picker";
import { botConversationRoutePath, botConversationsRoutePath } from "@/services/app-routes";
import {
    AttachmentReadError,
    ReadPromptImage,
    ReadPromptResource,
    readPromptAttachment,
} from "@/services/attachment-reader";
import {
    readBotConversationMessages,
    readBotConversationSession,
    updateBotConversationWorkspace,
    uploadBotPromptAttachments,
} from "@/services/bot-api";
import { configureConversationSession, listWorkspace, prepareConversationSession } from "@/services/mobius-transport";

const BOT_WORKING_ANNOUNCEMENT = "Message accepted. The approved local runtime is working.";
const BOT_COMPOSER_MAX_HEIGHT = 180;

abstract class ConversationDirectoryState {}

class LoadingConversationDirectoryState extends ConversationDirectoryState {}

class ReadyConversationDirectoryState extends ConversationDirectoryState {
    readonly conversations: readonly MobiusBotConversation[];

    constructor(conversations: readonly MobiusBotConversation[]) {
        super();
        this.conversations = conversations;
    }
}

class FailedConversationDirectoryState extends ConversationDirectoryState {
    readonly message: string;

    constructor(message: string) {
        super();
        this.message = message;
    }
}

abstract class ConversationTurnState {
    abstract readonly kind: string;
}

class IdleConversationTurnState extends ConversationTurnState {
    readonly kind = "idle";
}

class RunningConversationTurnState extends ConversationTurnState {
    readonly kind = "running";
    readonly turnId: string;

    constructor(turnId: string) {
        super();
        this.turnId = turnId;
    }
}

class UnidentifiedRunningConversationTurnState extends ConversationTurnState {
    readonly kind = "running_without_identifier";
}

abstract class ConversationViewState {}

class LoadingConversationViewState extends ConversationViewState {}

class ReadyConversationViewState extends ConversationViewState {
    readonly conversation: MobiusBotConversation;
    readonly messages: readonly MobiusMessage[];
    readonly nextCursor: string;
    readonly turn: ConversationTurnState;

    constructor(
        conversation: MobiusBotConversation,
        messages: readonly MobiusMessage[],
        nextCursor: string,
        turn: ConversationTurnState,
    ) {
        super();
        this.conversation = conversation;
        this.messages = messages;
        this.nextCursor = nextCursor;
        this.turn = turn;
    }
}

class FailedConversationViewState extends ConversationViewState {
    readonly message: string;

    constructor(message: string) {
        super();
        this.message = message;
    }
}

abstract class BotComposerSessionState {
    abstract readonly statusLabel: string;
}

class LoadingBotComposerSessionState extends BotComposerSessionState {
    readonly statusLabel = "Preparing local agent…";
}

class PreparingBotComposerSessionState extends BotComposerSessionState {
    readonly directoryLabel: string;
    readonly session: MobiusSession;
    readonly statusLabel = "Preparing local agent…";

    constructor(session: MobiusSession, directoryLabel: string) {
        super();
        this.directoryLabel = directoryLabel;
        this.session = session;
    }
}

class ReadyBotComposerSessionState extends BotComposerSessionState {
    readonly ready: SessionReadyEvent;
    readonly session: MobiusSession;
    readonly statusLabel = "Local agent ready";

    constructor(session: MobiusSession, ready: SessionReadyEvent) {
        super();
        this.ready = ready;
        this.session = session;
    }
}

class FailedBotComposerSessionState extends BotComposerSessionState {
    readonly message: string;
    readonly statusLabel = "Local agent unavailable";

    constructor(message: string) {
        super();
        this.message = message;
    }
}

class FailedPreparedBotComposerSessionState extends FailedBotComposerSessionState {
    readonly directoryLabel: string;
    readonly session: MobiusSession;

    constructor(session: MobiusSession, directoryLabel: string, message: string) {
        super(message);
        this.directoryLabel = directoryLabel;
        this.session = session;
    }
}

abstract class OptimisticBotPromptState {}

class EmptyOptimisticBotPromptState extends OptimisticBotPromptState {}

class PendingOptimisticBotPromptState extends OptimisticBotPromptState {
    readonly clientMessageId: string;
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
    readonly text: string;

    constructor(
        clientMessageId: string,
        text: string,
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
    ) {
        super();
        this.clientMessageId = clientMessageId;
        this.text = text;
        this.images = Object.freeze([...images]);
        this.resources = Object.freeze([...resources]);
    }
}

function failureMessage(error: unknown): string {
    if (error instanceof MobiusApiError) {
        return `${error.code}: ${error.message}`;
    }
    return error instanceof Error ? error.message : "The conversation request failed.";
}

function formattedDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function turnState(
    messages: readonly MobiusMessage[],
    events: readonly MobiusBotConversationEvent[],
): ConversationTurnState {
    const latestMessage = messages.at(-1);
    if (
        latestMessage === undefined ||
        latestMessage.attempt.kind === "succeeded" ||
        latestMessage.attempt.kind === "failed" ||
        latestMessage.attempt.kind === "cancelled"
    ) {
        return new IdleConversationTurnState();
    }
    const latestEvent = events.findLast((event) => event.payload["commandId"] === latestMessage.commandId);
    if (latestEvent === undefined) {
        return new UnidentifiedRunningConversationTurnState();
    }
    if (
        latestEvent.kind === "session.completed" ||
        latestEvent.kind === "session.failed" ||
        latestEvent.kind === "session.cancelled"
    ) {
        return new IdleConversationTurnState();
    }
    return new RunningConversationTurnState(latestEvent.turnId);
}

function conversationTitle(conversation: MobiusBotConversation): string {
    return conversation.title.trim().length > 0 ? conversation.title : "Untitled conversation";
}

function retitleConversation(conversation: MobiusBotConversation, title: string): MobiusBotConversation {
    return new MobiusBotConversation(
        {
            behaviorRevisionId: conversation.behaviorRevisionId,
            bindingId: conversation.bindingId,
            bindingRevision: conversation.bindingRevision,
            botId: conversation.botId,
            clientConversationKey: conversation.clientConversationKey,
            conversationId: conversation.conversationId,
            createdAt: conversation.createdAt,
            creatorPrincipalId: conversation.creatorPrincipalId,
            sessionId: conversation.sessionId,
            title,
        },
        conversation.origin,
        conversation.state,
    );
}

function mergeConversationMessages(
    current: readonly MobiusMessage[],
    received: readonly MobiusMessage[],
): readonly MobiusMessage[] {
    const messages = new Map(current.map((message) => [message.commandId, message]));
    for (const message of received) {
        messages.set(message.commandId, message);
    }
    return Object.freeze(
        [...messages.values()].sort((left, right) => {
            const timeDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
            return timeDifference === 0 ? left.commandId.localeCompare(right.commandId) : timeDifference;
        }),
    );
}

export function BotConversationsPage() {
    const { bot, client, connection, signal } = useOutletContext<BotDetailContext>();
    const navigate = useNavigate();
    const errorSummaryRef = useRef<HTMLDivElement>(null);
    const [state, setState] = useState<ConversationDirectoryState>(new LoadingConversationDirectoryState());
    const [creating, setCreating] = useState(false);
    const [formError, setFormError] = useState("");

    const loadConversations = useCallback(async (): Promise<void> => {
        setState(new LoadingConversationDirectoryState());
        try {
            const directory = await client.listConversations(bot.botId, signal);
            setState(new ReadyConversationDirectoryState(directory.conversations));
        } catch (error) {
            if (!signal.aborted) {
                setState(new FailedConversationDirectoryState(failureMessage(error)));
            }
        }
    }, [bot.botId, client, signal]);

    useEffect(() => {
        void loadConversations();
    }, [loadConversations]);

    const createConversation = async (): Promise<void> => {
        setCreating(true);
        setFormError("");
        try {
            const conversation = await client.createConversation(
                bot.botId,
                { clientConversationKey: `web_${crypto.randomUUID()}` },
                signal,
            );
            await navigate(botConversationRoutePath(connection.channelId, bot.botId, conversation.conversationId));
        } catch (error) {
            if (!signal.aborted) {
                setFormError(failureMessage(error));
                queueMicrotask(() => errorSummaryRef.current?.focus());
            }
        } finally {
            if (!signal.aborted) {
                setCreating(false);
            }
        }
    };

    const canCreate = bot.state.kind === "active";
    return (
        <div className="mx-auto w-full max-w-[920px] px-5 py-7 sm:px-8 sm:py-9">
            <section aria-labelledby="bot-conversations-heading">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                    <div className="max-w-2xl">
                        <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
                            Durable Sessions
                        </p>
                        <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em]" id="bot-conversations-heading">
                            Conversations
                        </h2>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                            Each conversation stays pinned to the behavior and execution-binding revision active when it
                            was created.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            aria-busy={state instanceof LoadingConversationDirectoryState}
                            aria-label="Refresh conversations"
                            className="size-11 shrink-0"
                            disabled={state instanceof LoadingConversationDirectoryState}
                            onClick={() => void loadConversations()}
                            size="icon"
                            variant="ghost"
                        >
                            <RefreshCw
                                aria-hidden="true"
                                className={
                                    state instanceof LoadingConversationDirectoryState
                                        ? "size-4 animate-spin"
                                        : "size-4"
                                }
                            />
                        </Button>
                        <Button
                            aria-busy={creating}
                            className="min-h-11 shrink-0"
                            disabled={!canCreate || creating}
                            onClick={() => void createConversation()}
                        >
                            {creating ? (
                                <LoaderCircle
                                    aria-hidden="true"
                                    className="size-4 animate-spin motion-reduce:animate-none"
                                />
                            ) : (
                                <Plus aria-hidden="true" className="size-4" />
                            )}
                            New chat
                        </Button>
                    </div>
                </div>
                {!canCreate && (
                    <p className="mt-4 rounded-xl border border-[#f2d39b] bg-[#fffaf0] px-4 py-3 text-xs leading-5 text-[#7b4c00]">
                        Activate this Bot before creating a conversation. Suspended and archived Bots keep their history
                        but do not accept new turns.
                    </p>
                )}
                {formError.length > 0 && (
                    <div
                        className="mt-4 rounded-lg border border-[#f2c4c4] bg-[#fff7f7] px-3 py-2 text-sm text-[#9b2c32] outline-none"
                        ref={errorSummaryRef}
                        role="alert"
                        tabIndex={-1}
                    >
                        {formError}
                    </div>
                )}
            </section>

            <section aria-label="Bot conversation directory" className="mt-8">
                {state instanceof LoadingConversationDirectoryState && (
                    <div
                        aria-busy="true"
                        className="flex min-h-24 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 text-sm text-muted-foreground"
                    >
                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading conversations…
                    </div>
                )}
                {state instanceof FailedConversationDirectoryState && (
                    <div className="rounded-xl border border-[#f2c4c4] bg-[#fff7f7] p-4">
                        <BotInlineError>{state.message}</BotInlineError>
                        <Button className="mt-3 min-h-11" onClick={() => void loadConversations()} variant="outline">
                            <RefreshCw aria-hidden="true" className="size-4" /> Retry
                        </Button>
                    </div>
                )}
                {state instanceof ReadyConversationDirectoryState && state.conversations.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-black/15 bg-white/60 px-6 py-10 text-center">
                        <MessageSquare aria-hidden="true" className="mx-auto size-6 text-[#218854]" />
                        <p className="mt-3 text-sm font-semibold">No conversations yet</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            Start one after the Bot has an approved execution binding.
                        </p>
                    </div>
                )}
                {state instanceof ReadyConversationDirectoryState && state.conversations.length > 0 && (
                    <ul aria-label="Bot conversations" className="grid gap-2">
                        {state.conversations.map((conversation) => (
                            <li key={conversation.conversationId}>
                                <Link
                                    className="flex min-h-20 items-center gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-4 py-3 text-foreground no-underline shadow-[0_1px_3px_rgba(0,0,0,0.03)] transition-colors hover:border-black/16 hover:bg-black/[0.012] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                                    to={botConversationRoutePath(
                                        connection.channelId,
                                        bot.botId,
                                        conversation.conversationId,
                                    )}
                                >
                                    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[#eefaf3] text-[#218854]">
                                        <MessageSquare aria-hidden="true" className="size-4" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <strong className="block truncate text-sm font-semibold">
                                            {conversationTitle(conversation)}
                                        </strong>
                                        <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                                            {conversation.origin.kind === "owner"
                                                ? "Owner conversation"
                                                : "External connection"}
                                            {" · "}
                                            {formattedDate(conversation.createdAt)}
                                        </span>
                                    </span>
                                    <span className="rounded-full bg-black/5 px-2 py-1 text-[10px] font-semibold text-muted-foreground">
                                        {conversation.state.kind}
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

function ConversationMessage({ botName, message }: { readonly botName: string; readonly message: MobiusMessage }) {
    const running =
        message.attempt.kind === "none" ||
        message.attempt.kind === "dispatching" ||
        message.attempt.kind === "running" ||
        message.attempt.kind === "waiting_input";
    return (
        <li className="contents">
            <UserPromptMessage images={message.images} resources={message.resources} text={message.prompt} />
            <article aria-label={`Message from ${botName}`} className="mb-9 min-w-0">
                {message.response.length > 0 ? (
                    <div className="agent-stream min-w-0">
                        <AgentMarkdown markdown={message.response} streaming={running} />
                    </div>
                ) : running ? (
                    <div
                        aria-label={`${botName} is working`}
                        className="thinking-indicator mt-1.5 inline-flex h-6 items-center gap-1"
                        role="status"
                    >
                        <span />
                        <span />
                        <span />
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">No response was recorded for this turn.</p>
                )}
                {message.attempt.kind === "failed" && (
                    <p className="mt-2 text-xs text-[#9b2c32]">
                        The turn failed before a complete response was recorded.
                    </p>
                )}
                {message.attempt.kind === "cancelled" && (
                    <p className="mt-2 text-xs text-muted-foreground">This turn was cancelled.</p>
                )}
            </article>
        </li>
    );
}

export function BotConversationPage() {
    const { bot, client, connection, signal } = useOutletContext<BotDetailContext>();
    const params = useParams<"conversationId">();
    const conversationId = params.conversationId ?? "";
    const [state, setState] = useState<ConversationViewState>(new LoadingConversationViewState());
    const [composerSession, setComposerSession] = useState<BotComposerSessionState>(
        new LoadingBotComposerSessionState(),
    );
    const [draft, setDraft] = useState("");
    const [draftImages, setDraftImages] = useState<readonly PromptImage[]>([]);
    const [draftResources, setDraftResources] = useState<readonly PromptResource[]>([]);
    const [optimisticPrompt, setOptimisticPrompt] = useState<OptimisticBotPromptState>(
        new EmptyOptimisticBotPromptState(),
    );
    const [preparationRevision, setPreparationRevision] = useState(0);
    const [attaching, setAttaching] = useState(false);
    const [configuring, setConfiguring] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [loadingEarlier, setLoadingEarlier] = useState(false);
    const [operationError, setOperationError] = useState("");
    const [announcement, setAnnouncement] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const configuringRef = useRef(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const turnWasRunningRef = useRef(false);

    const loadConversation = useCallback(async (): Promise<void> => {
        try {
            const directory = await client.listConversations(bot.botId, signal);
            const conversation = directory.conversations.find(
                (candidate) => candidate.conversationId === conversationId,
            );
            if (conversation === undefined) {
                setState(new FailedConversationViewState("The Bot conversation does not exist."));
                return;
            }
            const [messages, events] = await Promise.all([
                readBotConversationMessages(connection, conversation.sessionId, "", signal),
                client.readConversationEvents(bot.botId, conversation.conversationId, "", signal),
            ]);
            const chronologicalMessages = messages.messages.toReversed();
            const currentTurn = turnState(chronologicalMessages, events.events);
            setState((current) => {
                const previous =
                    current instanceof ReadyConversationViewState &&
                    current.conversation.conversationId === conversation.conversationId
                        ? current
                        : undefined;
                return new ReadyConversationViewState(
                    conversation,
                    mergeConversationMessages(previous?.messages ?? [], chronologicalMessages),
                    previous?.nextCursor ?? messages.nextCursor,
                    currentTurn,
                );
            });
            if (
                optimisticPrompt instanceof PendingOptimisticBotPromptState &&
                messages.messages.some((message) => message.commandId === optimisticPrompt.clientMessageId)
            ) {
                setOptimisticPrompt(new EmptyOptimisticBotPromptState());
            }
        } catch (error) {
            if (!signal.aborted) {
                setState(new FailedConversationViewState(failureMessage(error)));
            }
        }
    }, [bot.botId, client, connection, conversationId, optimisticPrompt, signal]);

    useEffect(() => {
        void loadConversation();
    }, [loadConversation]);

    const ready = state instanceof ReadyConversationViewState ? state : undefined;
    const turnRunning = ready?.turn.kind === "running" || ready?.turn.kind === "running_without_identifier";
    const readySessionId =
        ready !== undefined && ready.conversation.origin.kind === "owner" ? ready.conversation.sessionId : "";

    useEffect(() => {
        if (readySessionId.length === 0) {
            return;
        }
        const controller = new AbortController();
        const operationSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120_000)]);
        setComposerSession(new LoadingBotComposerSessionState());
        void readBotConversationSession(connection, readySessionId, operationSignal)
            .then(async (session) => {
                setComposerSession(new PreparingBotComposerSessionState(session, session.defaultBinding.workspaceRef));
                const prepared = await prepareConversationSession(
                    {
                        additionalDirectoryIds: [],
                        agentId: session.defaultBinding.agentRef,
                        bindingId: session.defaultBinding.bindingId,
                        directoryId: session.defaultBinding.workspaceRef,
                        requestId: `bot-prepare-${preparationRevision.toString()}-${crypto.randomUUID()}`,
                        sessionId: session.sessionId,
                    },
                    operationSignal,
                );
                const refreshedSession = await readBotConversationSession(
                    connection,
                    session.sessionId,
                    operationSignal,
                );
                setComposerSession(new ReadyBotComposerSessionState(refreshedSession, prepared));
                setOperationError("");
            })
            .catch((error: unknown) => {
                if (!operationSignal.aborted) {
                    setComposerSession(new FailedBotComposerSessionState(failureMessage(error)));
                }
            });
        return () => controller.abort();
    }, [connection, preparationRevision, readySessionId, signal]);

    useEffect(() => {
        const responseCompleted = turnWasRunningRef.current && !turnRunning;
        turnWasRunningRef.current = turnRunning;
        if (responseCompleted && announcement === BOT_WORKING_ANNOUNCEMENT) {
            setAnnouncement("Response completed.");
        }
    }, [announcement, turnRunning]);

    useEffect(() => {
        if (!turnRunning) {
            return;
        }
        let cancelled = false;
        let timeout = 0;
        const refresh = async (): Promise<void> => {
            await loadConversation();
            if (!cancelled) {
                timeout = window.setTimeout(() => void refresh(), 1_500);
            }
        };
        timeout = window.setTimeout(() => void refresh(), 1_500);
        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [loadConversation, turnRunning]);

    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (textarea === null) {
            return;
        }
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, BOT_COMPOSER_MAX_HEIGHT).toString()}px`;
    });

    const attachFiles = (files: FileList): void => {
        if (!(composerSession instanceof ReadyBotComposerSessionState)) {
            return;
        }
        const prepared = composerSession.ready;
        const selected = Array.from(files).slice(0, 8);
        setAttaching(true);
        void Promise.all(selected.map(async (file) => await readPromptAttachment(file)))
            .then((attachments) => {
                let images = [...draftImages];
                let resources = [...draftResources];
                for (const attachment of attachments) {
                    if (attachment instanceof ReadPromptImage) {
                        if (!prepared.capabilities.imagePrompt) {
                            throw new AttachmentReadError(
                                "image_prompt_unsupported",
                                `${bot.displayName} does not accept image prompts.`,
                            );
                        }
                        images = [...images.filter((image) => image.name !== attachment.image.name), attachment.image];
                    } else if (attachment instanceof ReadPromptResource) {
                        if (!prepared.capabilities.embeddedContextPrompt) {
                            throw new AttachmentReadError(
                                "resource_prompt_unsupported",
                                `${bot.displayName} does not accept embedded resources.`,
                            );
                        }
                        resources = [
                            ...resources.filter((resource) => resource.name !== attachment.resource.name),
                            attachment.resource,
                        ];
                    }
                }
                setDraftImages(Object.freeze(images));
                setDraftResources(Object.freeze(resources));
                setOperationError("");
            })
            .catch((error: unknown) => {
                setOperationError(
                    error instanceof AttachmentReadError
                        ? `${error.code}: ${error.message}`
                        : "attachment_read_failed: The selected file could not be read.",
                );
            })
            .finally(() => {
                setAttaching(false);
                if (fileInputRef.current !== null) {
                    fileInputRef.current.value = "";
                }
            });
    };

    const selectWorkspace = async (directory: WorkspaceEntry): Promise<void> => {
        if (
            ready === undefined ||
            !(composerSession instanceof ReadyBotComposerSessionState) ||
            ready.messages.length > 0 ||
            optimisticPrompt instanceof PendingOptimisticBotPromptState ||
            turnRunning ||
            configuringRef.current
        ) {
            throw new Error("The workspace is fixed after the first message");
        }
        const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        let targetSession = composerSession.session;
        setComposerSession(new PreparingBotComposerSessionState(targetSession, directory.name));
        try {
            targetSession = await updateBotConversationWorkspace(
                connection,
                targetSession,
                directory.directoryId,
                operationSignal,
            );
            const prepared = await prepareConversationSession(
                {
                    additionalDirectoryIds: [],
                    agentId: targetSession.defaultBinding.agentRef,
                    bindingId: targetSession.defaultBinding.bindingId,
                    directoryId: targetSession.defaultBinding.workspaceRef,
                    sessionId: targetSession.sessionId,
                },
                operationSignal,
            );
            targetSession = await readBotConversationSession(connection, targetSession.sessionId, operationSignal);
            setComposerSession(new ReadyBotComposerSessionState(targetSession, prepared));
            setOperationError("");
        } catch (error) {
            const message = failureMessage(error);
            setComposerSession(new FailedPreparedBotComposerSessionState(targetSession, directory.name, message));
            setOperationError(message);
            throw error;
        }
    };

    const configureBotOption = async (
        option: SessionConfigOption,
        value: string,
        booleanValue: boolean,
    ): Promise<string> => {
        if (!(composerSession instanceof ReadyBotComposerSessionState)) {
            return "The local Bot session is not ready.";
        }
        if (configuringRef.current) {
            return "Wait for the current session setting to finish.";
        }
        const activeComposer = composerSession;
        configuringRef.current = true;
        setConfiguring(true);
        try {
            const configured = await configureConversationSession(
                {
                    additionalDirectoryIds: [],
                    agentId: activeComposer.session.defaultBinding.agentRef,
                    bindingId: activeComposer.session.defaultBinding.bindingId,
                    booleanValue,
                    configId: option.id,
                    directoryId: activeComposer.session.defaultBinding.workspaceRef,
                    sessionId: activeComposer.session.sessionId,
                    value,
                    valueType: option.type,
                },
                AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
            );
            const refreshedSession = await readBotConversationSession(
                connection,
                activeComposer.session.sessionId,
                AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
            );
            setComposerSession((current) =>
                current instanceof ReadyBotComposerSessionState &&
                current.session.sessionId === activeComposer.session.sessionId
                    ? new ReadyBotComposerSessionState(refreshedSession, {
                          ...current.ready,
                          configOptions: configured.configOptions,
                      })
                    : current,
            );
            return "";
        } catch (error) {
            return failureMessage(error);
        } finally {
            configuringRef.current = false;
            if (!signal.aborted) {
                setConfiguring(false);
            }
        }
    };

    const submit = async (): Promise<void> => {
        const ownerConversation = ready?.conversation.origin.kind === "owner";
        if (
            ready === undefined ||
            (ownerConversation && !(composerSession instanceof ReadyBotComposerSessionState)) ||
            (!ownerConversation && (draftImages.length > 0 || draftResources.length > 0)) ||
            (draft.trim().length === 0 && draftImages.length === 0 && draftResources.length === 0) ||
            turnRunning ||
            configuringRef.current
        ) {
            return;
        }
        const prompt = draft.trim();
        const images = draftImages;
        const resources = draftResources;
        const clientMessageId = `web_${crypto.randomUUID()}`;
        setSubmitting(true);
        setDraft("");
        setDraftImages([]);
        setDraftResources([]);
        setOptimisticPrompt(new PendingOptimisticBotPromptState(clientMessageId, prompt, images, resources));
        setOperationError("");
        setAnnouncement("");
        try {
            const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
            const artifactIds = ownerConversation
                ? await uploadBotPromptAttachments(
                      connection,
                      ready.conversation.sessionId,
                      images,
                      resources,
                      operationSignal,
                  )
                : [];
            const accepted = await client.submitMessage(
                bot.botId,
                ready.conversation.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds,
                    clientMessageId,
                    text: prompt,
                },
                operationSignal,
            );
            const titleSource = prompt.length > 0 ? prompt : (images[0]?.name ?? resources[0]?.name ?? "Attachment");
            const conversation =
                ownerConversation && ready.messages.length === 0
                    ? retitleConversation(ready.conversation, conversationTitleFromText(titleSource))
                    : ready.conversation;
            setState(
                new ReadyConversationViewState(
                    conversation,
                    ready.messages,
                    ready.nextCursor,
                    new RunningConversationTurnState(accepted.turnId),
                ),
            );
            setAnnouncement(BOT_WORKING_ANNOUNCEMENT);
        } catch (error) {
            if (!signal.aborted) {
                setDraft(prompt);
                setDraftImages(images);
                setDraftResources(resources);
                setOptimisticPrompt(new EmptyOptimisticBotPromptState());
                setOperationError(failureMessage(error));
            }
        } finally {
            if (!signal.aborted) {
                setSubmitting(false);
            }
        }
    };

    const loadEarlierMessages = async (current: ReadyConversationViewState): Promise<void> => {
        if (current.nextCursor.length === 0) {
            return;
        }
        setLoadingEarlier(true);
        setOperationError("");
        try {
            const page = await readBotConversationMessages(
                connection,
                current.conversation.sessionId,
                current.nextCursor,
                signal,
            );
            setState((latest) => {
                if (
                    !(latest instanceof ReadyConversationViewState) ||
                    latest.conversation.conversationId !== current.conversation.conversationId
                ) {
                    return latest;
                }
                return new ReadyConversationViewState(
                    latest.conversation,
                    mergeConversationMessages(latest.messages, page.messages.toReversed()),
                    page.nextCursor,
                    latest.turn,
                );
            });
        } catch (error) {
            if (!signal.aborted) {
                setOperationError(failureMessage(error));
            }
        } finally {
            if (!signal.aborted) {
                setLoadingEarlier(false);
            }
        }
    };

    const cancel = async (running: RunningConversationTurnState): Promise<void> => {
        setCancelling(true);
        setOperationError("");
        try {
            await client.cancelTurn(bot.botId, running.turnId, `web_${crypto.randomUUID()}`, signal);
            setAnnouncement("Cancellation accepted.");
            await loadConversation();
        } catch (error) {
            if (!signal.aborted) {
                setOperationError(failureMessage(error));
            }
        } finally {
            if (!signal.aborted) {
                setCancelling(false);
            }
        }
    };

    if (state instanceof LoadingConversationViewState) {
        return (
            <div
                aria-busy="true"
                className="flex min-h-64 items-center justify-center gap-3 text-sm text-muted-foreground"
            >
                <LoaderCircle aria-hidden="true" className="size-5 animate-spin" /> Loading conversation…
            </div>
        );
    }
    if (state instanceof FailedConversationViewState) {
        return (
            <div className="mx-auto w-full max-w-[760px] px-5 py-8 sm:px-8">
                <Link
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground no-underline hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                    to={botConversationsRoutePath(connection.channelId, bot.botId)}
                >
                    <ArrowLeft aria-hidden="true" className="size-4" /> Conversations
                </Link>
                <div className="mt-5 rounded-xl border border-[#f2c4c4] bg-[#fff7f7] p-5">
                    <BotInlineError>{state.message}</BotInlineError>
                    <Button className="mt-3 min-h-11" onClick={() => void loadConversation()} variant="outline">
                        <RefreshCw aria-hidden="true" className="size-4" /> Retry
                    </Button>
                </div>
            </div>
        );
    }
    if (ready === undefined) {
        return null;
    }
    const cancellableTurn = ready.turn instanceof RunningConversationTurnState ? ready.turn : undefined;
    const preparedComposer = composerSession instanceof ReadyBotComposerSessionState ? composerSession : undefined;
    const preparedFailure = composerSession instanceof FailedBotComposerSessionState ? composerSession.message : "";
    const composerDirectoryId =
        preparedComposer?.session.defaultBinding.workspaceRef ??
        (composerSession instanceof FailedPreparedBotComposerSessionState
            ? composerSession.session.defaultBinding.workspaceRef
            : "default");
    const composerDirectoryLabel =
        preparedComposer?.ready.directoryLabel ??
        (composerSession instanceof PreparingBotComposerSessionState ||
        composerSession instanceof FailedPreparedBotComposerSessionState
            ? composerSession.directoryLabel
            : "Approved workspace");
    const hasOptimisticPrompt = optimisticPrompt instanceof PendingOptimisticBotPromptState;
    const ownerConversation = ready.conversation.origin.kind === "owner";
    const hasDraftContent =
        draft.trim().length > 0 || (ownerConversation && (draftImages.length > 0 || draftResources.length > 0));
    const canAttach =
        ownerConversation &&
        preparedComposer !== undefined &&
        !configuring &&
        (preparedComposer.ready.capabilities.imagePrompt || preparedComposer.ready.capabilities.embeddedContextPrompt);
    const workspaceLocked =
        preparedComposer === undefined ||
        ready.messages.length > 0 ||
        hasOptimisticPrompt ||
        turnRunning ||
        configuring;
    const canSubmit =
        hasDraftContent &&
        (!ownerConversation || preparedComposer !== undefined) &&
        !submitting &&
        !configuring &&
        !turnRunning &&
        bot.state.kind === "active";

    return (
        <div className="flex min-h-full flex-col">
            <div className="mx-auto w-full max-w-[840px] px-5 pt-5 sm:px-8">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b-[0.5px] border-black/8 pb-4">
                    <div className="flex min-w-0 items-center gap-2">
                        <Link
                            aria-label="Back to conversations"
                            className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground no-underline hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                            to={botConversationsRoutePath(connection.channelId, bot.botId)}
                        >
                            <ArrowLeft aria-hidden="true" className="size-4" />
                        </Link>
                        <span className="min-w-0">
                            <h2 className="truncate text-base font-semibold tracking-[-0.015em]">
                                {conversationTitle(ready.conversation)}
                            </h2>
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                Behavior revision {ready.conversation.behaviorRevisionId.slice(-6)} · Binding v
                                {ready.conversation.bindingRevision}
                            </span>
                        </span>
                    </div>
                    <Button
                        aria-label="Refresh conversation"
                        className="size-11 sm:size-9"
                        onClick={() => void loadConversation()}
                        size="icon"
                        variant="ghost"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" />
                    </Button>
                </div>
            </div>

            <div className="mx-auto w-full max-w-[840px] flex-1 px-5 py-6 sm:px-8">
                {ready.nextCursor.length > 0 && (
                    <div className="mb-6 flex justify-center">
                        <Button
                            aria-busy={loadingEarlier}
                            className="min-h-11"
                            disabled={loadingEarlier}
                            onClick={() => void loadEarlierMessages(ready)}
                            variant="outline"
                        >
                            {loadingEarlier && <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />}
                            Load earlier messages
                        </Button>
                    </div>
                )}
                {ready.messages.length === 0 && !hasOptimisticPrompt ? (
                    <section className="mx-auto mt-8 max-w-lg text-center">
                        <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-[#eefaf3] text-[#218854]">
                            <Bot aria-hidden="true" className="size-5" />
                        </span>
                        <h3 className="mt-4 text-lg font-semibold">Message {bot.displayName}</h3>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            This conversation is pinned to its approved local behavior and execution target.
                        </p>
                    </section>
                ) : (
                    <ol aria-label="Conversation messages" className="contents">
                        {ready.messages.map((message) => (
                            <ConversationMessage botName={bot.displayName} key={message.commandId} message={message} />
                        ))}
                        {optimisticPrompt instanceof PendingOptimisticBotPromptState &&
                            !ready.messages.some(
                                (message) => message.commandId === optimisticPrompt.clientMessageId,
                            ) && (
                                <li className="contents">
                                    <UserPromptMessage
                                        images={optimisticPrompt.images}
                                        resources={optimisticPrompt.resources}
                                        text={optimisticPrompt.text}
                                    />
                                    <div
                                        aria-label={`${bot.displayName} is working`}
                                        className="thinking-indicator mb-9 inline-flex h-6 items-center gap-1"
                                        role="status"
                                    >
                                        <span />
                                        <span />
                                        <span />
                                    </div>
                                </li>
                            )}
                    </ol>
                )}
            </div>

            <div className="sticky bottom-0 z-[8] mt-auto bg-gradient-to-t from-background via-background to-transparent px-2 pt-2 pb-3 md:px-3 md:pt-3">
                {operationError.length > 0 && (
                    <div
                        className="mx-auto mb-2 w-full max-w-[840px] rounded-[9px] border-[0.5px] border-destructive/20 bg-destructive/5 px-[11px] py-[9px] text-xs leading-[18px] text-destructive"
                        role="alert"
                    >
                        {operationError}
                    </div>
                )}
                <form
                    aria-busy={submitting || configuring || composerSession instanceof PreparingBotComposerSessionState}
                    className="composer-shell relative mx-auto w-full max-w-[840px] rounded-2xl bg-white px-2 py-1.5 sm:px-2.5 sm:py-2 md:rounded-[18px] md:px-3 md:py-2.5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    {(draftImages.length > 0 || draftResources.length > 0) && (
                        <fieldset className="mb-2 flex flex-wrap items-center gap-1.5" data-selected-context="">
                            <legend className="sr-only">Selected files</legend>
                            {draftImages.length > 0 && (
                                <ul aria-label="Prompt images" className="contents">
                                    {draftImages.map((image, index) => (
                                        <li
                                            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border-[0.5px] border-black/9 bg-surface-subtle py-1 pr-1 pl-2 text-[11px] text-copy-secondary lg:min-h-9"
                                            key={`${index.toString()}:${image.name}`}
                                        >
                                            <ImageIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                                            <span className="max-w-40 truncate">{image.name}</span>
                                            <Button
                                                aria-label={`Remove ${image.name}`}
                                                className="size-11 lg:size-8"
                                                onClick={() =>
                                                    setDraftImages((current) =>
                                                        current.filter((_, candidate) => candidate !== index),
                                                    )
                                                }
                                                size="icon"
                                                type="button"
                                                variant="ghost"
                                            >
                                                <X aria-hidden="true" className="size-3" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {draftResources.length > 0 && (
                                <ul aria-label="Prompt resources" className="contents">
                                    {draftResources.map((resource, index) => (
                                        <li
                                            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border-[0.5px] border-black/9 bg-surface-subtle py-1 pr-1 pl-2 text-[11px] text-copy-secondary lg:min-h-9"
                                            key={`${index.toString()}:${resource.uri}`}
                                        >
                                            <FileText aria-hidden="true" className="size-3.5 text-muted-foreground" />
                                            <span className="max-w-40 truncate">{resource.name}</span>
                                            <Button
                                                aria-label={`Remove ${resource.name}`}
                                                className="size-11 lg:size-8"
                                                onClick={() =>
                                                    setDraftResources((current) =>
                                                        current.filter((_, candidate) => candidate !== index),
                                                    )
                                                }
                                                size="icon"
                                                type="button"
                                                variant="ghost"
                                            >
                                                <X aria-hidden="true" className="size-3" />
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </fieldset>
                    )}
                    <label className="sr-only" htmlFor="bot-message-composer">
                        Message {bot.displayName}
                    </label>
                    <textarea
                        aria-describedby="bot-composer-hint"
                        className="max-h-44 min-h-12 w-full resize-none bg-transparent px-1 py-2 text-base leading-6 outline-none placeholder:text-muted-foreground sm:text-sm md:min-h-16"
                        disabled={submitting || turnRunning || bot.state.kind !== "active"}
                        id="bot-message-composer"
                        maxLength={100000}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void submit();
                            }
                        }}
                        placeholder={
                            turnRunning
                                ? `${bot.displayName} is working…`
                                : ownerConversation && preparedComposer === undefined
                                  ? composerSession.statusLabel
                                  : `Message ${bot.displayName}`
                        }
                        ref={textareaRef}
                        rows={1}
                        value={draft}
                    />
                    <div className="mt-1 flex min-h-11 items-center justify-between gap-1 lg:mt-2.5 lg:min-h-9 lg:gap-2">
                        <fieldset className="flex min-w-0 flex-1 items-center gap-0.5 sm:gap-1">
                            <legend className="sr-only">Prompt and run controls</legend>
                            {ownerConversation && (
                                <>
                                    <Button
                                        aria-label="Attach images or text resources"
                                        className="size-11 rounded-full text-copy-secondary hover:bg-black/[0.04] lg:size-9"
                                        disabled={!canAttach || turnRunning || attaching}
                                        onClick={() => fileInputRef.current?.click()}
                                        size="icon"
                                        title={
                                            canAttach
                                                ? "Attach images or text resources"
                                                : "This agent does not support attachments"
                                        }
                                        type="button"
                                        variant="ghost"
                                    >
                                        {attaching ? (
                                            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                                        ) : (
                                            <Paperclip className="size-4" />
                                        )}
                                    </Button>
                                    <input
                                        accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.csv,.yaml,.yml,.xml"
                                        aria-label="Choose files for Bot prompt"
                                        className="sr-only"
                                        multiple
                                        onChange={(event) => {
                                            if (event.currentTarget.files !== null) {
                                                attachFiles(event.currentTarget.files);
                                            }
                                        }}
                                        ref={fileInputRef}
                                        type="file"
                                    />
                                </>
                            )}
                            {ownerConversation ? (
                                <>
                                    <WorkspacePickerControl
                                        additionalDirectories={[]}
                                        canAddAdditionalDirectories={false}
                                        directoryId={composerDirectoryId}
                                        directoryLabel={composerDirectoryLabel}
                                        listDirectories={(directoryId, listSignal) =>
                                            listWorkspace(directoryId, AbortSignal.any([signal, listSignal]))
                                        }
                                        locked={workspaceLocked}
                                        onFailure={setOperationError}
                                        onSelectPrimary={selectWorkspace}
                                        onToggleAdditional={() => undefined}
                                    />
                                    <SessionConfigControlsView
                                        agentLabel={preparedComposer?.ready.agentName ?? bot.displayName}
                                        directoryLabel={composerDirectoryLabel}
                                        failure={preparedFailure}
                                        isPreparing={
                                            composerSession instanceof LoadingBotComposerSessionState ||
                                            composerSession instanceof PreparingBotComposerSessionState
                                        }
                                        isReady={preparedComposer !== undefined}
                                        isRunning={turnRunning}
                                        onConfigure={configureBotOption}
                                        onRetry={() => setPreparationRevision((current) => current + 1)}
                                        options={preparedComposer?.ready.configOptions ?? []}
                                        statusLabel={composerSession.statusLabel}
                                    />
                                </>
                            ) : (
                                <span className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 text-[11px] text-muted-foreground lg:min-h-9">
                                    <LockKeyhole aria-hidden="true" className="size-3.5" /> Pinned Bot settings
                                </span>
                            )}
                        </fieldset>
                        {cancellableTurn !== undefined ? (
                            <Button
                                aria-busy={cancelling}
                                aria-label="Stop response"
                                className="size-11 rounded-full lg:size-9"
                                disabled={cancelling}
                                onClick={() => void cancel(cancellableTurn)}
                                size="icon"
                                type="button"
                                variant="outline"
                            >
                                {cancelling ? (
                                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                ) : (
                                    <Square aria-hidden="true" className="size-3.5 fill-current" />
                                )}
                            </Button>
                        ) : (
                            <Button
                                aria-label="Send message"
                                className="size-11 rounded-full lg:size-9"
                                disabled={!canSubmit}
                                size="icon"
                                type="submit"
                            >
                                {submitting ? (
                                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                ) : (
                                    <Send aria-hidden="true" className="size-4" />
                                )}
                            </Button>
                        )}
                    </div>
                </form>
                <span className="sr-only" id="bot-composer-hint">
                    Enter to send. Shift and Enter inserts a new line.
                </span>
                <p aria-live="polite" className="sr-only">
                    {announcement}
                </p>
            </div>
        </div>
    );
}
