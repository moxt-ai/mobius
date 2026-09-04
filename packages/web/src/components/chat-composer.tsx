import { Bot, Folder, LoaderCircle, Send, Square } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
} from "react";

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
import { sendPrompt, stopActiveTurn } from "@/services/mobius-transport";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

const COMPOSER_MAX_HEIGHT = 180;

export function ChatComposer() {
  const agents = useChatStore((state) => state.agents);
  const conversation = useChatStore(selectActiveConversation);
  const errorMessage = useChatStore((state) => state.errorMessage);
  const runtime = useChatStore((state) => state.runtime);
  const selectAgent = useChatStore((state) => state.selectAgent);
  const setDraft = useChatStore((state) => state.setDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend =
    runtime.canSend &&
    !conversation.isRunning &&
    conversation.draft.trim().length > 0;

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

  return (
    <footer className="z-[8] shrink-0 bg-background px-6 pt-2.5 pb-3.5 max-md:px-2.5 max-md:pt-[9px] max-md:pb-2.5">
      {errorMessage.length > 0 && (
        <div
          className="mx-auto mb-2 w-full max-w-[900px] rounded-[9px] border-[0.5px] border-[#b4232a]/20 bg-[#fff1f0] px-[11px] py-[9px] text-xs leading-[18px] text-[#b4232a]"
          role="alert"
        >
          {errorMessage}
        </div>
      )}
      <form
        className="composer-shell mx-auto w-full max-w-[900px] rounded-xl bg-white px-[11px] pt-2.5 pb-[9px] max-md:px-[9px] max-md:pt-[9px] max-md:pb-2"
        onSubmit={submit}
      >
        <label className="sr-only" htmlFor="agent-prompt">
          Message the local agent
        </label>
        <Textarea
          aria-describedby="composer-hint connection-hint"
          id="agent-prompt"
          maxLength={10000}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Ask the local agent anything"
          ref={textareaRef}
          rows={1}
          value={conversation.draft}
        />
        <div className="flex min-h-[36px] items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Select
              disabled={conversation.messages.length > 0}
              onValueChange={selectAgent}
              value={conversation.agentId}
            >
              <SelectTrigger
                aria-label="Agent for this conversation"
                className="h-9 min-w-[138px] max-w-[180px]"
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
            <div
              className="inline-flex min-h-9 min-w-0 items-center gap-1.5 rounded-[8px] bg-black/5 px-2 text-[11px] font-medium text-[#454959] max-[480px]:hidden"
              title="Authorized local binding"
            >
              <Folder className="size-3.5 text-muted-foreground" />
              <span>workspace</span>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-[11px]">
            <span
              className="text-[10px] leading-4 text-muted-foreground max-md:hidden"
              id="composer-hint"
            >
              Enter to send · Shift + Enter for new line
            </span>
            <Button
              aria-label={
                conversation.isRunning
                  ? conversation.canStop
                    ? "Stop agent"
                    : "Stopping agent"
                  : "Send message"
              }
              className={cn(
                "size-11 rounded-full border-0 p-0 shadow-none hover:-translate-y-px sm:size-[34px]",
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
      <p
        className="mx-auto mt-[7px] mb-0 w-full max-w-[900px] text-center text-[10px] leading-[15px] text-muted-foreground max-md:mt-[5px]"
        id="connection-hint"
      >
        {runtime.description}
      </p>
    </footer>
  );
}
