import { SessionPromptDisposition } from "@moxt-ai/mobius-sdk";
import { FileText, Image as ImageIcon, LoaderCircle, Paperclip, Send, Square, X } from "lucide-react";
import {
    type ClipboardEvent,
    type FormEvent,
    type KeyboardEvent,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import { AgentPicker } from "@/components/agent-picker";
import { SessionConfigControls } from "@/components/session-config-controls";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { WorkspacePicker } from "@/components/workspace-picker";
import { dataTestId } from "@/data-testid";
import { DeletedSessionState, type UserChatMessage } from "@/domain/chat";
import { cn } from "@/lib/utils";
import {
    AttachmentReadError,
    pastedImageFileName,
    type ReadPromptAttachment,
    ReadPromptImage,
    ReadPromptResource,
    readClipboardImage,
    readPromptAttachment,
} from "@/services/attachment-reader";
import { hasSelectedComposerContext } from "@/services/composer-selected-context";
import { prepareActiveSession, sendPrompt, steerQueuedPrompt, stopActiveTurn } from "@/services/mobius-transport";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

const COMPOSER_MAX_HEIGHT = 180;
const CONTEXT_CIRCLE_SIZE = 18;
const CONTEXT_CIRCLE_STROKE = 2.5;
const CONTEXT_CIRCLE_RADIUS = (CONTEXT_CIRCLE_SIZE - CONTEXT_CIRCLE_STROKE) / 2;
const CONTEXT_CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_CIRCLE_RADIUS;

function ContextUsageIndicator() {
    const conversation = useChatStore(selectActiveConversation);
    const usage = conversation.session.usage;
    if (!usage.available) {
        return null;
    }
    const offset = CONTEXT_CIRCLE_CIRCUMFERENCE * (1 - usage.percent / 100);
    const hasContext = usage.context !== null;
    const detail = `${hasContext ? `${usage.percent.toString()}% · ` : ""}${usage.summary}${usage.costLabel.length > 0 ? ` · ${usage.costLabel}` : ""}`;

    return (
        <details className="group/context relative">
            <summary
                aria-label={`Agent usage: ${detail}`}
                className="flex size-11 cursor-pointer list-none items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-black/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 lg:size-9"
                title={detail}
            >
                <svg
                    aria-hidden="true"
                    className="block -rotate-90"
                    height={CONTEXT_CIRCLE_SIZE}
                    viewBox={`0 0 ${CONTEXT_CIRCLE_SIZE.toString()} ${CONTEXT_CIRCLE_SIZE.toString()}`}
                    width={CONTEXT_CIRCLE_SIZE}
                >
                    <circle
                        cx={CONTEXT_CIRCLE_SIZE / 2}
                        cy={CONTEXT_CIRCLE_SIZE / 2}
                        fill="none"
                        r={CONTEXT_CIRCLE_RADIUS}
                        stroke="rgba(11, 26, 57, 0.09)"
                        strokeWidth={CONTEXT_CIRCLE_STROKE}
                    />
                    <circle
                        className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
                        cx={CONTEXT_CIRCLE_SIZE / 2}
                        cy={CONTEXT_CIRCLE_SIZE / 2}
                        fill="none"
                        r={CONTEXT_CIRCLE_RADIUS}
                        stroke="var(--copy-tertiary)"
                        strokeDasharray={CONTEXT_CIRCLE_CIRCUMFERENCE}
                        strokeDashoffset={offset}
                        strokeLinecap="round"
                        strokeWidth={CONTEXT_CIRCLE_STROKE}
                    />
                </svg>
            </summary>
            <div className="absolute right-0 bottom-[calc(100%+8px)] z-40 w-64 rounded-xl border-[0.5px] border-black/10 bg-white p-3 shadow-[0_14px_40px_rgba(0,0,0,0.14)]">
                <div className="flex items-center justify-between text-xs font-medium text-foreground">
                    <span>Agent usage</span>
                </div>
                {/*
                 * The live context window and the last prompt's counters come from different events at
                 * different moments, so each group gets its own heading. Without them the table reads as a
                 * breakdown of the ratio above it, which makes a correctly-computed number look wrong.
                 */}
                {hasContext && (
                    <section aria-label="Context window" className="mt-2">
                        <div className="flex items-center justify-between text-[10px] leading-4 font-semibold tracking-[0.04em] text-copy-tertiary uppercase">
                            <h3>Context window</h3>
                            <span className="tabular-nums">{usage.percent.toString()}% used</span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
                            <span
                                className="block h-full rounded-full bg-copy-tertiary transition-[width] duration-300 motion-reduce:transition-none"
                                style={{ width: `${usage.percent.toString()}%` }}
                            />
                        </div>
                        <p className="mt-1.5 text-[11px] leading-[18px] text-muted-foreground">{usage.summary}</p>
                        {usage.costLabel.length > 0 && (
                            <p className="mt-0.5 text-[11px] leading-[18px] text-muted-foreground">{usage.costLabel}</p>
                        )}
                    </section>
                )}
                {usage.details.length > 0 && (
                    <section aria-label="Last prompt" className="mt-2 border-t border-black/[0.06] pt-2">
                        <h3 className="text-[10px] leading-4 font-semibold tracking-[0.04em] text-copy-tertiary uppercase">
                            Last prompt
                        </h3>
                        <dl className="mt-1 max-h-64 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                            {usage.details.map((detail, index) => (
                                <div
                                    className="flex items-start justify-between gap-3"
                                    key={`${index.toString()}-${detail.label}`}
                                >
                                    <dt className="min-w-0 break-words">{detail.label}</dt>
                                    <dd className="shrink-0 tabular-nums">{detail.value}</dd>
                                </div>
                            ))}
                        </dl>
                    </section>
                )}
            </div>
        </details>
    );
}

function followUpSummary(message: UserChatMessage): string {
    if (message.text.length > 0) {
        return message.text;
    }
    const attachmentCount = message.images.length + message.resources.length;
    return `${attachmentCount.toString()} attached ${attachmentCount === 1 ? "item" : "items"}`;
}

function FollowUpTray() {
    const conversation = useChatStore(selectActiveConversation);
    const messages = conversation.followUpMessages;
    if (messages.length === 0) {
        return null;
    }

    return (
        <section
            aria-label="Pending follow-up messages"
            aria-live="polite"
            className="mx-auto mb-2 w-full max-w-[840px] overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white/95 shadow-[0_4px_18px_rgba(0,0,0,0.06)] backdrop-blur-sm"
            role="status"
        >
            <div className="flex items-center justify-between border-b border-black/[0.055] px-3 py-1.5">
                <span className="text-[10px] font-semibold tracking-[0.055em] text-copy-tertiary uppercase">
                    Pending follow-ups
                </span>
                <span className="text-[10px] tabular-nums text-copy-tertiary">{messages.length.toString()}</span>
            </div>
            <ol className="max-h-32 overflow-y-auto p-1.5">
                {messages.map((message) => (
                    <li className="flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5" key={message.id}>
                        <span className="inline-flex shrink-0 rounded-md bg-black/[0.045] px-1.5 py-0.5 text-[10px] leading-4 font-semibold text-copy-secondary">
                            Queued
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-copy-secondary" title={message.text}>
                            {followUpSummary(message)}
                        </span>
                        {conversation.session.capabilities.steering && (
                            <Button
                                aria-label={`Steer queued message: ${followUpSummary(message)}`}
                                className="h-8 shrink-0 rounded-full px-3 text-xs text-success hover:bg-success-subtle hover:text-success"
                                onClick={() => {
                                    void steerQueuedPrompt(message.commandId);
                                }}
                                type="button"
                                variant="ghost"
                            >
                                Steer
                            </Button>
                        )}
                    </li>
                ))}
            </ol>
        </section>
    );
}

interface PromptAttachmentSource {
    readonly read: () => Promise<ReadPromptAttachment>;
}

interface ChatComposerProps {
    readonly placement: "active" | "idle";
}

export function ChatComposer({ placement }: ChatComposerProps) {
    const conversation = useChatStore(selectActiveConversation);
    const errorMessage = useChatStore((state) => state.errorMessage);
    const runtime = useChatStore((state) => state.runtime);
    const toggleAdditionalDirectory = useChatStore((state) => state.toggleAdditionalDirectory);
    const addDraftImage = useChatStore((state) => state.addDraftImage);
    const addDraftResource = useChatStore((state) => state.addDraftResource);
    const removeDraftImage = useChatStore((state) => state.removeDraftImage);
    const removeDraftResource = useChatStore((state) => state.removeDraftResource);
    const setDraft = useChatStore((state) => state.setDraft);
    const setErrorMessage = useChatStore((state) => state.setErrorMessage);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [attaching, setAttaching] = useState(false);
    const [commandIndex, setCommandIndex] = useState(0);
    const commandQuery = conversation.draft.startsWith("/")
        ? (conversation.draft.slice(1).split(/\s/u, 1)[0]?.toLowerCase() ?? "")
        : "";
    const commandSuggestions = conversation.draft.startsWith("/")
        ? conversation.session.commands
              .filter((command) => command.name.toLowerCase().includes(commandQuery))
              .slice(0, 8)
        : [];
    const hasPromptContent =
        conversation.draft.trim().length > 0 ||
        conversation.draftImages.length > 0 ||
        conversation.draftResources.length > 0;
    let activeDisposition: string = SessionPromptDisposition.Reject;
    if (conversation.isRunning) {
        activeDisposition = SessionPromptDisposition.Queue;
    }
    const canSubmitWhileRunning = activeDisposition !== SessionPromptDisposition.Reject;
    const canSend =
        runtime.canSend &&
        conversation.session.isReady &&
        hasPromptContent &&
        (!conversation.isRunning || canSubmitWhileRunning);
    const sendLabel =
        activeDisposition === SessionPromptDisposition.Queue
            ? "Queue message"
            : activeDisposition === SessionPromptDisposition.Steer
              ? "Steer agent"
              : "Send message";
    const canAttach =
        conversation.session.capabilities.imagePrompt || conversation.session.capabilities.embeddedContextPrompt;
    const hasSelectedContext = hasSelectedComposerContext({
        additionalDirectoryCount: conversation.additionalDirectories.length,
        imageCount: conversation.draftImages.length,
        resourceCount: conversation.draftResources.length,
    });

    useEffect(() => {
        if (runtime.canSend && conversation.session.autoPrepare) {
            void prepareActiveSession(conversation.sessionId);
        }
    }, [conversation.session.autoPrepare, conversation.sessionId, runtime.canSend]);

    useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (textarea === null) {
            return;
        }
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT).toString()}px`;
    });

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        if (canSend) {
            void sendPrompt(conversation.draft, activeDisposition);
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (commandSuggestions.length > 0 && event.key === "ArrowDown") {
            event.preventDefault();
            setCommandIndex((current) => (current + 1) % commandSuggestions.length);
            return;
        }
        if (commandSuggestions.length > 0 && event.key === "ArrowUp") {
            event.preventDefault();
            setCommandIndex((current) => (current - 1 + commandSuggestions.length) % commandSuggestions.length);
            return;
        }
        if (commandSuggestions.length > 0 && (event.key === "Tab" || event.key === "Enter")) {
            const command = commandSuggestions[commandIndex];
            if (command !== undefined) {
                event.preventDefault();
                setDraft(`/${command.name} `);
                return;
            }
        }
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }
        event.preventDefault();
        if (canSend) {
            void sendPrompt(conversation.draft, activeDisposition);
        }
    };

    const attachPromptFiles = (selected: readonly PromptAttachmentSource[]): void => {
        setAttaching(true);
        void Promise.all(selected.map(async (source) => await source.read()))
            .then((attachments) => {
                for (const attachment of attachments) {
                    if (attachment instanceof ReadPromptImage) {
                        if (!conversation.session.capabilities.imagePrompt) {
                            throw new AttachmentReadError(
                                "image_prompt_unsupported",
                                `${conversation.agentLabel} does not accept image prompts.`,
                            );
                        }
                        addDraftImage(attachment.image);
                    } else if (attachment instanceof ReadPromptResource) {
                        if (!conversation.session.capabilities.embeddedContextPrompt) {
                            throw new AttachmentReadError(
                                "resource_prompt_unsupported",
                                `${conversation.agentLabel} does not accept embedded resources.`,
                            );
                        }
                        addDraftResource(attachment.resource);
                    }
                }
                setErrorMessage("");
            })
            .catch((error: unknown) => {
                setErrorMessage(
                    error instanceof AttachmentReadError
                        ? `${error.code}: ${error.message}`
                        : "attachment_read_failed: The selected file could not be read.",
                );
            })
            .finally(() => {
                setAttaching(false);
            });
    };

    const attachFiles = (files: FileList): void => {
        attachPromptFiles(
            Array.from(files)
                .slice(0, 8)
                .map((file) => ({ read: async () => await readPromptAttachment(file) })),
        );
        if (fileInputRef.current !== null) {
            fileInputRef.current.value = "";
        }
    };

    const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        // `files` and `items` are two views over the same payload, so pick one rather than merging them.
        // `items` is the richer API and carries the kind; `files` is the fallback for browsers that skip it.
        const clipboard = event.clipboardData;
        const fromItems = Array.from(clipboard?.items ?? [])
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
        const images = (fromItems.length > 0 ? fromItems : Array.from(clipboard?.files ?? [])).filter((file) =>
            file.type.startsWith("image/"),
        );
        if (images.length === 0) {
            return;
        }
        // Keep the image out of the textarea, but still let non-image clipboard payloads paste normally.
        event.preventDefault();
        if (!conversation.session.capabilities.imagePrompt) {
            setErrorMessage(`image_prompt_unsupported: ${conversation.agentLabel} does not accept image prompts.`);
            return;
        }
        // Claim every name synchronously so a multi-image paste cannot make two entries collide.
        const taken = new Set(conversation.draftImages.map((image) => image.name));
        attachPromptFiles(
            images.slice(0, 8).map((file) => {
                const name =
                    file.name.length > 0 && !taken.has(file.name) ? file.name : pastedImageFileName(file.type, taken);
                taken.add(name);
                return { read: async () => await readClipboardImage(file, name) };
            }),
        );
    };

    return (
        <footer
            className={cn(
                "relative z-[8] shrink-0 text-left",
                placement === "active"
                    ? "chat-composer-active bg-gradient-to-t from-background via-background to-transparent px-2 pt-2 pb-3 md:px-3 md:pt-3"
                    : "mt-5 w-full bg-transparent sm:mt-6",
            )}
            data-composer-placement={placement}
        >
            {conversation.session instanceof DeletedSessionState ? (
                <p className="mx-auto mb-3 max-w-[840px] text-sm text-muted-foreground" role="status">
                    This native session was deleted. Start a new chat to continue. Messages recorded here are retained.
                </p>
            ) : conversation.session.restored && conversation.messages.length === 0 ? (
                <p className="mx-auto mb-3 max-w-[840px] text-sm text-muted-foreground">
                    Continue with the Agent’s saved context.
                </p>
            ) : null}
            {errorMessage.length > 0 && (
                <div
                    className="mx-auto mb-2 w-full max-w-[840px] rounded-[9px] border-[0.5px] border-destructive/20 bg-destructive/5 px-[11px] py-[9px] text-xs leading-[18px] text-destructive"
                    role="alert"
                >
                    {errorMessage}
                </div>
            )}
            <FollowUpTray />
            <form
                className="composer-shell relative mx-auto w-full max-w-[840px] rounded-2xl bg-white px-2 py-1.5 sm:px-2.5 sm:py-2 md:rounded-[18px] md:px-3 md:py-2.5"
                onSubmit={submit}
            >
                {hasSelectedContext && (
                    <fieldset className="mb-2 flex flex-wrap items-center gap-1.5" data-selected-context="">
                        <legend className="sr-only">Selected files and directories</legend>
                        {conversation.additionalDirectories.map((directory) => (
                            <span
                                className="inline-flex min-h-11 max-w-44 items-center gap-1 rounded-full bg-success-subtle py-0.5 pr-0.5 pl-2.5 text-[11px] font-medium text-success lg:min-h-9"
                                key={directory.directoryId}
                                title="Additional agent directory"
                            >
                                <span className="truncate">+ {directory.name}</span>
                                <Button
                                    aria-label={`Remove ${directory.name}`}
                                    className="size-11 rounded-full text-success lg:size-8"
                                    disabled={conversation.contextLocked}
                                    onClick={() => toggleAdditionalDirectory(directory)}
                                    size="icon"
                                    variant="ghost"
                                >
                                    <X className="size-3" />
                                </Button>
                            </span>
                        ))}
                        {conversation.draftImages.length > 0 && (
                            <ul aria-label="Prompt images" className="contents">
                                {conversation.draftImages.map((image) => (
                                    <li
                                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border-[0.5px] border-black/9 bg-surface-subtle py-1 pr-1 pl-2 text-[11px] text-copy-secondary lg:min-h-9"
                                        key={image.name}
                                    >
                                        <ImageIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                                        <span className="max-w-40 truncate">{image.name}</span>
                                        <Button
                                            aria-label={`Remove ${image.name}`}
                                            className="size-11 lg:size-8"
                                            onClick={() => removeDraftImage(image.name)}
                                            size="icon"
                                            variant="ghost"
                                        >
                                            <X className="size-3" />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {conversation.draftResources.length > 0 && (
                            <ul aria-label="Prompt resources" className="contents">
                                {conversation.draftResources.map((resource) => (
                                    <li
                                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border-[0.5px] border-black/9 bg-surface-subtle py-1 pr-1 pl-2 text-[11px] text-copy-secondary lg:min-h-9"
                                        data-testid={dataTestId.promptAttachment}
                                        key={resource.uri}
                                    >
                                        <FileText aria-hidden="true" className="size-3.5 text-muted-foreground" />
                                        <span className="max-w-40 truncate">{resource.name}</span>
                                        <Button
                                            aria-label={`Remove ${resource.name}`}
                                            className="size-11 lg:size-8"
                                            onClick={() => removeDraftResource(resource.name)}
                                            size="icon"
                                            variant="ghost"
                                        >
                                            <X className="size-3" />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </fieldset>
                )}
                <label className="sr-only" htmlFor="agent-prompt">
                    Message the local agent
                </label>
                <Textarea
                    aria-describedby="composer-hint connection-hint"
                    className={cn(placement === "active" ? "min-h-12 lg:min-h-16" : "min-h-12 md:min-h-16")}
                    data-testid={dataTestId.promptInput}
                    id="agent-prompt"
                    maxLength={10000}
                    onChange={(event) => {
                        setCommandIndex(0);
                        setDraft(event.currentTarget.value);
                    }}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    placeholder={conversation.session.isReady ? "Ask the local agent…" : conversation.session.label}
                    ref={textareaRef}
                    rows={1}
                    value={conversation.draft}
                />
                {commandSuggestions.length > 0 && (
                    <div
                        aria-label="Agent commands"
                        className="absolute right-3 bottom-[58px] left-3 z-30 overflow-hidden rounded-xl border-[0.5px] border-black/10 bg-white p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.14)]"
                        role="listbox"
                    >
                        {commandSuggestions.map((command, index) => (
                            <button
                                aria-selected={commandIndex === index}
                                className={cn(
                                    "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-ring/70",
                                    commandIndex === index && "bg-black/[0.045]",
                                )}
                                key={command.name}
                                onMouseEnter={() => setCommandIndex(index)}
                                onClick={() => setDraft(`/${command.name} `)}
                                role="option"
                                type="button"
                            >
                                <code className="shrink-0 text-xs font-semibold text-success">/{command.name}</code>
                                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                                    {command.description}
                                </span>
                                {command.inputHint.length > 0 && (
                                    <span className="hidden text-[10px] text-copy-tertiary sm:block">
                                        {command.inputHint}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                )}
                <div className="mt-1 flex min-h-11 items-center justify-between gap-1 lg:mt-2.5 lg:min-h-9 lg:gap-2">
                    <fieldset className="flex min-w-0 flex-1 items-center gap-0.5 sm:gap-1">
                        <legend className="sr-only">Prompt and run controls</legend>
                        <Button
                            aria-label="Attach images or text resources"
                            className="size-11 rounded-full text-copy-secondary hover:bg-black/[0.04] lg:size-9"
                            data-testid={dataTestId.attachPromptFiles}
                            disabled={!canAttach || attaching}
                            onClick={() => fileInputRef.current?.click()}
                            size="icon"
                            title={
                                canAttach
                                    ? "Attach images or text resources"
                                    : "This agent does not support attachments"
                            }
                            variant="ghost"
                        >
                            {attaching ? (
                                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                            ) : (
                                <Paperclip className="size-4" />
                            )}
                        </Button>
                        {/*
                         * The visible attach button opens this native picker, so the input is a programmatic
                         * target only. Left exposed it is announced as a second, unlabeled control whose
                         * "Choose Files / No file chosen" name does not describe what may be attached.
                         */}
                        <input
                            accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.csv,.yaml,.yml,.xml"
                            aria-hidden="true"
                            className="sr-only"
                            data-testid={dataTestId.promptFileInput}
                            multiple
                            onChange={(event) => {
                                if (event.currentTarget.files !== null) {
                                    attachFiles(event.currentTarget.files);
                                }
                            }}
                            ref={fileInputRef}
                            tabIndex={-1}
                            type="file"
                        />
                        <WorkspacePicker key={`workspace:${conversation.id}`} />
                        <AgentPicker />
                        <SessionConfigControls key={`settings:${conversation.id}`} />
                    </fieldset>
                    <div className="flex shrink-0 items-center gap-1 md:gap-2">
                        <ContextUsageIndicator />
                        {conversation.isRunning && (
                            <Button
                                aria-label={conversation.canStop ? "Stop agent" : "Stopping agent"}
                                className="group size-11 rounded-full border-0 bg-transparent p-0 shadow-none hover:bg-transparent lg:size-9"
                                disabled={!conversation.canStop}
                                onClick={() => {
                                    void stopActiveTurn();
                                }}
                                size="icon"
                                type="button"
                            >
                                <span
                                    aria-hidden="true"
                                    className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive transition-colors duration-150 group-hover:bg-destructive/15 motion-reduce:transition-none"
                                >
                                    {conversation.canStop ? (
                                        <Square className="size-[14px] fill-current" />
                                    ) : (
                                        <LoaderCircle className="size-4 animate-spin" />
                                    )}
                                </span>
                            </Button>
                        )}
                        <Button
                            aria-label={sendLabel}
                            className="group size-11 rounded-full border-0 bg-transparent p-0 shadow-none hover:bg-transparent lg:size-9"
                            data-testid={dataTestId.sendPrompt}
                            disabled={!canSend}
                            size="icon"
                            title={sendLabel}
                            type="submit"
                        >
                            <span
                                aria-hidden="true"
                                className="flex size-9 items-center justify-center rounded-full bg-foreground text-background transition-colors duration-150 group-hover:bg-foreground/85 motion-reduce:transition-none"
                            >
                                <Send className="size-4" />
                            </span>
                        </Button>
                    </div>
                </div>
            </form>
            <span className="sr-only" id="composer-hint">
                Enter to send. Shift and Enter inserts a new line.
            </span>
            <span className="sr-only" id="connection-hint">
                {runtime.description}
            </span>
        </footer>
    );
}
