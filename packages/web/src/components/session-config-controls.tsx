import type { SessionConfigOption } from "@moxt-ai/mobius-web-sdk";
import { Check, LoaderCircle, RefreshCw, Settings2, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspacePicker } from "@/components/workspace-picker";
import {
  ReadySessionState,
  SessionPreparationFailedState,
} from "@/domain/chat";
import {
  configureSessionOption,
  prepareActiveSession,
} from "@/services/mobius-transport";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

function SelectConfigControl({
  additionalDirectoryIds,
  agentId,
  disabled,
  directoryId,
  option,
  pending,
  sessionId,
  setPending,
}: {
  readonly additionalDirectoryIds: readonly string[];
  readonly disabled: boolean;
  readonly agentId: string;
  readonly directoryId: string;
  readonly option: SessionConfigOption;
  readonly pending: boolean;
  readonly sessionId: string;
  readonly setPending: (id: string) => void;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(value) => {
        if (value === option.currentValue) {
          return;
        }
        setPending(option.id);
        void configureSessionOption(
          agentId,
          sessionId,
          directoryId,
          additionalDirectoryIds,
          option,
          value,
          false,
        ).finally(() => {
          setPending("");
        });
      }}
      value={option.currentValue}
    >
      <SelectTrigger
        aria-label={option.name}
        className="h-8 min-w-[108px] max-w-[170px] shrink-0 rounded-full border-0 bg-transparent px-2 text-muted-foreground shadow-none hover:bg-black/[0.045] hover:text-foreground"
        title={option.description.length > 0 ? option.description : option.name}
      >
        <span className="min-w-0 truncate">
          <span className="mr-1 text-[10px] text-muted-foreground">
            {option.name}
          </span>
          <SelectValue />
        </span>
        {pending && (
          <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
        )}
      </SelectTrigger>
      <SelectContent>
        {option.values.map((value) => (
          <SelectItem key={value.value} value={value.value}>
            <span title={value.description}>{value.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function BooleanConfigControl({
  additionalDirectoryIds,
  agentId,
  disabled,
  directoryId,
  option,
  pending,
  sessionId,
  setPending,
}: {
  readonly additionalDirectoryIds: readonly string[];
  readonly disabled: boolean;
  readonly agentId: string;
  readonly directoryId: string;
  readonly option: SessionConfigOption;
  readonly pending: boolean;
  readonly sessionId: string;
  readonly setPending: (id: string) => void;
}) {
  return (
    <button
      aria-checked={option.booleanValue}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-black/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[#2fb872]/35 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={() => {
        setPending(option.id);
        void configureSessionOption(
          agentId,
          sessionId,
          directoryId,
          additionalDirectoryIds,
          option,
          "",
          !option.booleanValue,
        ).finally(() => {
          setPending("");
        });
      }}
      role="switch"
      title={option.description.length > 0 ? option.description : option.name}
      type="button"
    >
      <span
        aria-hidden="true"
        className="flex size-4 items-center justify-center rounded border-[0.5px] border-black/15 bg-black/[0.035]"
      >
        {pending ? (
          <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
        ) : (
          option.booleanValue && <Check className="size-3 text-[#227b4e]" />
        )}
      </span>
      {option.name}
    </button>
  );
}

export function SessionConfigControls() {
  const conversation = useChatStore(selectActiveConversation);
  const toggleAdditionalDirectory = useChatStore(
    (state) => state.toggleAdditionalDirectory,
  );
  const [pendingId, setPendingId] = useState("");
  const disabled = conversation.isRunning || pendingId.length > 0;

  return (
    <div className="contents">
      <WorkspacePicker />
      {conversation.additionalDirectories.map((directory) => (
        <span
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-[#edf8f2] px-2 text-[11px] font-medium text-[#227b4e]"
          key={directory.directoryId}
          title="Additional agent directory"
        >
          + {directory.name}
          <Button
            aria-label={`Remove ${directory.name}`}
            className="ml-0.5 size-6 rounded-full text-[#227b4e]"
            disabled={conversation.messages.length > 0}
            onClick={() => toggleAdditionalDirectory(directory)}
            size="icon"
            variant="ghost"
          >
            <X className="size-3" />
          </Button>
        </span>
      ))}
      {conversation.session instanceof ReadySessionState ? (
        conversation.session.configOptions.map((option) =>
          option.type === "select" ? (
            <SelectConfigControl
              additionalDirectoryIds={conversation.additionalDirectories.map(
                (directory) => directory.directoryId,
              )}
              agentId={conversation.agentId}
              disabled={disabled}
              directoryId={conversation.directoryId}
              key={option.id}
              option={option}
              pending={pendingId === option.id}
              sessionId={conversation.sessionId}
              setPending={setPendingId}
            />
          ) : (
            <BooleanConfigControl
              additionalDirectoryIds={conversation.additionalDirectories.map(
                (directory) => directory.directoryId,
              )}
              agentId={conversation.agentId}
              disabled={disabled}
              directoryId={conversation.directoryId}
              key={option.id}
              option={option}
              pending={pendingId === option.id}
              sessionId={conversation.sessionId}
              setPending={setPendingId}
            />
          ),
        )
      ) : conversation.session instanceof SessionPreparationFailedState ? (
        <button
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] text-destructive outline-none hover:bg-destructive/5 focus-visible:ring-2 focus-visible:ring-destructive/25"
          onClick={() => {
            void prepareActiveSession(conversation.sessionId);
          }}
          title={conversation.session.error}
          type="button"
        >
          <RefreshCw className="size-3.5" />
          Retry agent
        </button>
      ) : (
        <span
          aria-live="polite"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
        >
          {conversation.session.isPreparing ? (
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Settings2 className="size-3.5" />
          )}
          {conversation.session.label}
        </span>
      )}
    </div>
  );
}
