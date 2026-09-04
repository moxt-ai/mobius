import {
  Bot,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { SessionConfigControls } from "@/components/session-config-controls";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  AttachmentReadError,
  ReadPromptImage,
  ReadPromptResource,
  readPromptAttachment,
} from "@/services/attachment-reader";
import {
  prepareActiveSession,
  sendPrompt,
  stopActiveTurn,
} from "@/services/mobius-transport";
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
  const detail = `${usage.percent.toString()}% · ${usage.summary}${usage.costLabel.length > 0 ? ` · ${usage.costLabel}` : ""}`;

  return (
    <details className="group/context relative">
      <summary
        aria-label={`Context usage: ${detail}`}
        className="flex size-9 cursor-pointer list-none items-center justify-center rounded-full text-[#737b89] outline-none hover:bg-black/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[#2fb872]/35"
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
            className="transition-[stroke-dashoffset] duration-300"
            cx={CONTEXT_CIRCLE_SIZE / 2}
            cy={CONTEXT_CIRCLE_SIZE / 2}
            fill="none"
            r={CONTEXT_CIRCLE_RADIUS}
            stroke="#737b89"
            strokeDasharray={CONTEXT_CIRCLE_CIRCUMFERENCE}
            strokeDashoffset={offset}
            strokeLinecap="round"
            strokeWidth={CONTEXT_CIRCLE_STROKE}
          />
        </svg>
      </summary>
      <div className="absolute right-0 bottom-[calc(100%+8px)] z-40 w-64 rounded-xl border-[0.5px] border-black/10 bg-white p-3 shadow-[0_14px_40px_rgba(0,0,0,0.14)]">
        <div className="flex items-center justify-between text-xs font-medium text-foreground">
          <span>Context usage</span>
          <span>{usage.percent.toString()}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
          <span
            className="block h-full rounded-full bg-[#737b89] transition-[width] duration-300"
            style={{ width: `${usage.percent.toString()}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] leading-[18px] text-muted-foreground">
          {usage.summary}
        </p>
        {usage.costLabel.length > 0 && (
          <p className="mt-0.5 text-[11px] leading-[18px] text-muted-foreground">
            {usage.costLabel}
          </p>
        )}
      </div>
    </details>
  );
}

export function ChatComposer() {
  const agents = useChatStore((state) => state.agents);
  const conversation = useChatStore(selectActiveConversation);
  const errorMessage = useChatStore((state) => state.errorMessage);
  const runtime = useChatStore((state) => state.runtime);
  const selectAgent = useChatStore((state) => state.selectAgent);
  const addDraftImage = useChatStore((state) => state.addDraftImage);
  const addDraftResource = useChatStore((state) => state.addDraftResource);
  const removeDraftImage = useChatStore((state) => state.removeDraftImage);
  const removeDraftResource = useChatStore(
    (state) => state.removeDraftResource,
  );
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
  const canSend =
    runtime.canSend &&
    !conversation.isRunning &&
    conversation.session.isReady &&
    hasPromptContent;
  const canAttach =
    conversation.session.capabilities.imagePrompt ||
    conversation.session.capabilities.embeddedContextPrompt;

  useEffect(() => {
    if (runtime.canSend && conversation.session.autoPrepare) {
      void prepareActiveSession(conversation.sessionId);
    }
  }, [
    conversation.session.autoPrepare,
    conversation.sessionId,
    runtime.canSend,
  ]);

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
      void sendPrompt(conversation.draft);
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
      setCommandIndex(
        (current) =>
          (current - 1 + commandSuggestions.length) % commandSuggestions.length,
      );
      return;
    }
    if (
      commandSuggestions.length > 0 &&
      (event.key === "Tab" || event.key === "Enter")
    ) {
      const command = commandSuggestions[commandIndex];
      if (command !== undefined) {
        event.preventDefault();
        setDraft(`/${command.name} `);
        return;
      }
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    if (canSend) {
      void sendPrompt(conversation.draft);
    }
  };

  const attachFiles = (files: FileList): void => {
    const selected = Array.from(files).slice(0, 8);
    setAttaching(true);
    void Promise.all(
      selected.map(async (file) => await readPromptAttachment(file)),
    )
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
        if (fileInputRef.current !== null) {
          fileInputRef.current.value = "";
        }
      });
  };

  return (
    <footer className="relative z-[8] shrink-0 bg-gradient-to-t from-background via-background to-transparent px-3 pt-3 pb-3">
      {errorMessage.length > 0 && (
        <div
          className="mx-auto mb-2 w-full max-w-[976px] rounded-[9px] border-[0.5px] border-[#b4232a]/20 bg-[#fff1f0] px-[11px] py-[9px] text-xs leading-[18px] text-[#b4232a]"
          role="alert"
        >
          {errorMessage}
        </div>
      )}
      <form
        className="composer-shell relative mx-auto w-full max-w-[976px] rounded-lg bg-white px-3 py-2.5 max-md:px-2.5"
        onSubmit={submit}
      >
        {(conversation.draftImages.length > 0 ||
          conversation.draftResources.length > 0) && (
          <ul
            aria-label="Prompt attachments"
            className="mb-2 flex flex-wrap gap-1.5"
          >
            {conversation.draftImages.map((image) => (
              <li
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border-[0.5px] border-black/9 bg-[#f8f9fa] py-1 pr-1 pl-2 text-[11px] text-[#454959]"
                key={image.name}
              >
                <ImageIcon className="size-3.5 text-muted-foreground" />
                <span className="max-w-40 truncate">{image.name}</span>
                <Button
                  aria-label={`Remove ${image.name}`}
                  className="size-8"
                  onClick={() => removeDraftImage(image.name)}
                  size="icon"
                  variant="ghost"
                >
                  <X className="size-3" />
                </Button>
              </li>
            ))}
            {conversation.draftResources.map((resource) => (
              <li
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border-[0.5px] border-black/9 bg-[#f8f9fa] py-1 pr-1 pl-2 text-[11px] text-[#454959]"
                key={resource.uri}
              >
                <FileText className="size-3.5 text-muted-foreground" />
                <span className="max-w-40 truncate">{resource.name}</span>
                <Button
                  aria-label={`Remove ${resource.name}`}
                  className="size-8"
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
        <label className="sr-only" htmlFor="agent-prompt">
          Message the local agent
        </label>
        <Textarea
          aria-describedby="composer-hint connection-hint"
          id="agent-prompt"
          maxLength={10000}
          onChange={(event) => {
            setCommandIndex(0);
            setDraft(event.currentTarget.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            conversation.session.isReady
              ? "Ask the local agent anything — type / for commands"
              : conversation.session.label
          }
          ref={textareaRef}
          rows={1}
          value={conversation.draft}
        />
        {commandSuggestions.length > 0 && (
          <div
            aria-label="Agent commands"
            className="absolute right-3 bottom-[52px] left-3 z-30 overflow-hidden rounded-xl border-[0.5px] border-black/10 bg-white p-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.14)]"
            role="listbox"
          >
            {commandSuggestions.map((command, index) => (
              <button
                aria-selected={commandIndex === index}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-[#2fb872]/35",
                  commandIndex === index && "bg-black/[0.045]",
                )}
                key={command.name}
                onMouseEnter={() => setCommandIndex(index)}
                onClick={() => setDraft(`/${command.name} `)}
                role="option"
                type="button"
              >
                <code className="shrink-0 text-xs font-semibold text-[#227b4e]">
                  /{command.name}
                </code>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {command.description}
                </span>
                {command.inputHint.length > 0 && (
                  <span className="hidden text-[10px] text-[#8a919d] sm:block">
                    {command.inputHint}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="mt-2.5 flex min-h-8 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            <Button
              aria-label="Attach images or text resources"
              className="size-9 rounded-full"
              disabled={!canAttach || conversation.isRunning || attaching}
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
            <Select
              disabled={conversation.messages.length > 0}
              onValueChange={(agentId) => {
                if (agentId !== conversation.agentId) {
                  selectAgent(agentId);
                }
              }}
              value={conversation.agentId}
            >
              <SelectTrigger
                aria-label="Agent for this conversation"
                className="h-8 min-w-0 max-w-[150px] shrink-0 rounded-full border-0 bg-transparent px-2 text-muted-foreground shadow-none hover:bg-black/[0.045] hover:text-foreground"
                title={
                  conversation.messages.length > 0
                    ? "Start a new chat to choose another agent"
                    : "Choose a local agent"
                }
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Bot className="size-3.5 shrink-0 text-[#279a60]" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.csv,.yaml,.yml,.xml"
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
            <SessionConfigControls />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ContextUsageIndicator />
            <Button
              aria-label={
                conversation.isRunning
                  ? conversation.canStop
                    ? "Stop agent"
                    : "Stopping agent"
                  : "Send message"
              }
              className={cn(
                "size-10 rounded-full border-0 p-0 shadow-none sm:size-8",
                conversation.isRunning
                  ? "bg-[#fbe9e7] text-[#b4232a] hover:bg-[#f7d8d4]"
                  : "bg-[#2fb872] text-[#072e1d] hover:bg-[#3ac982]",
              )}
              disabled={
                conversation.isRunning ? !conversation.canStop : !canSend
              }
              onClick={
                conversation.isRunning
                  ? () => {
                      void stopActiveTurn();
                    }
                  : undefined
              }
              size="icon"
              type={conversation.isRunning ? "button" : "submit"}
            >
              {conversation.isRunning ? (
                conversation.canStop ? (
                  <Square className="size-[14px] fill-current" />
                ) : (
                  <LoaderCircle className="size-[18px] animate-spin" />
                )
              ) : (
                <Send className="size-[18px]" />
              )}
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
