import type {
  WorkspaceEntriesEvent,
  WorkspaceEntry,
} from "@moxt-ai/mobius-web-sdk";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderPlus,
  LoaderCircle,
  X,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { listWorkspace } from "@/services/mobius-transport";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

abstract class DirectoryBrowserState {
  abstract readonly open: boolean;
}

class ClosedDirectoryBrowserState extends DirectoryBrowserState {
  readonly open = false;
}

class LoadingDirectoryBrowserState extends DirectoryBrowserState {
  readonly directoryId: string;
  readonly open = true;

  constructor(directoryId: string) {
    super();
    this.directoryId = directoryId;
  }
}

class LoadedDirectoryBrowserState extends DirectoryBrowserState {
  readonly entries: WorkspaceEntriesEvent;
  readonly open = true;

  constructor(entries: WorkspaceEntriesEvent) {
    super();
    this.entries = entries;
  }
}

class FailedDirectoryBrowserState extends DirectoryBrowserState {
  readonly directoryId: string;
  readonly message: string;
  readonly open = true;

  constructor(directoryId: string, message: string) {
    super();
    this.directoryId = directoryId;
    this.message = message;
  }
}

function browserFailure(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The directory could not be loaded.";
}

export function WorkspacePicker() {
  const conversation = useChatStore(selectActiveConversation);
  const selectPrimaryDirectory = useChatStore(
    (state) => state.selectPrimaryDirectory,
  );
  const setErrorMessage = useChatStore((state) => state.setErrorMessage);
  const toggleAdditionalDirectory = useChatStore(
    (state) => state.toggleAdditionalDirectory,
  );
  const [browser, setBrowser] = useState<DirectoryBrowserState>(
    new ClosedDirectoryBrowserState(),
  );
  const locked = conversation.messages.length > 0 || conversation.isRunning;

  const load = (directoryId: string): void => {
    setBrowser(new LoadingDirectoryBrowserState(directoryId));
    void listWorkspace(directoryId)
      .then((entries) => {
        setBrowser(new LoadedDirectoryBrowserState(entries));
        setErrorMessage("");
      })
      .catch((error: unknown) => {
        const message = browserFailure(error);
        setBrowser(new FailedDirectoryBrowserState(directoryId, message));
        setErrorMessage(message);
      });
  };

  const choosePrimary = (directory: WorkspaceEntry): void => {
    selectPrimaryDirectory(directory);
    setBrowser(new ClosedDirectoryBrowserState());
  };

  return (
    <div className="relative min-w-0">
      <Button
        aria-expanded={browser.open}
        aria-haspopup="dialog"
        className="h-8 max-w-[180px] shrink-0 justify-start rounded-full border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-black/[0.045] hover:text-foreground"
        disabled={locked}
        onClick={() => {
          if (browser.open) {
            setBrowser(new ClosedDirectoryBrowserState());
          } else {
            load(conversation.directoryId);
          }
        }}
        title={
          locked
            ? "The workspace is fixed after the first message"
            : "Choose workspace directory"
        }
        variant="outline"
      >
        <Folder className="size-3.5 shrink-0 text-[#279a60]" />
        <span className="truncate">{conversation.directoryLabel}</span>
      </Button>
      {browser.open && (
        <section
          aria-label="Choose workspace directory"
          className="absolute bottom-[calc(100%+10px)] left-0 z-40 w-[min(390px,calc(100vw-28px))] overflow-hidden rounded-xl border-[0.5px] border-black/10 bg-white shadow-[0_16px_48px_rgba(0,0,0,0.16)]"
          role="dialog"
        >
          <header className="flex min-h-12 items-center gap-2 border-b-[0.5px] border-black/7 px-2.5">
            {browser instanceof LoadedDirectoryBrowserState &&
              browser.entries.parentDirectoryId.length > 0 && (
                <Button
                  aria-label="Open parent directory"
                  className="size-10 md:size-9"
                  onClick={() => {
                    load(browser.entries.parentDirectoryId);
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <ChevronLeft className="size-4" />
                </Button>
              )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-[#454959]">
                {browser instanceof LoadedDirectoryBrowserState
                  ? browser.entries.directoryLabel
                  : "Loading workspace"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                Local runtime authorized paths only
              </p>
            </div>
            <Button
              aria-label="Close directory browser"
              className="size-10 md:size-9"
              onClick={() => {
                setBrowser(new ClosedDirectoryBrowserState());
              }}
              size="icon"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          </header>
          {browser instanceof LoadingDirectoryBrowserState && (
            <div
              aria-live="polite"
              className="flex min-h-40 items-center justify-center gap-2 text-xs text-muted-foreground"
            >
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              Loading directories
            </div>
          )}
          {browser instanceof FailedDirectoryBrowserState && (
            <div className="p-4 text-center">
              <p className="text-xs leading-5 text-[#b4232a]">
                {browser.message}
              </p>
              <Button
                className="mt-3 min-h-10"
                onClick={() => load(browser.directoryId)}
                size="sm"
                variant="outline"
              >
                Try again
              </Button>
            </div>
          )}
          {browser instanceof LoadedDirectoryBrowserState && (
            <>
              <div className="max-h-64 overflow-y-auto p-1.5">
                {browser.entries.entries.length === 0 && (
                  <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                    No child directories
                  </p>
                )}
                {browser.entries.entries.map((entry) => {
                  const additional = conversation.additionalDirectories.some(
                    (directory) => directory.directoryId === entry.directoryId,
                  );
                  return (
                    <div
                      className="flex min-h-11 items-center gap-1 rounded-lg hover:bg-black/[0.035]"
                      key={entry.directoryId}
                    >
                      <button
                        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-[#2fb872]/35"
                        onClick={() => load(entry.directoryId)}
                        type="button"
                      >
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{entry.name}</span>
                        <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                      </button>
                      {conversation.session.capabilities
                        .additionalDirectories && (
                        <Button
                          aria-label={
                            additional
                              ? `Remove ${entry.name} from additional directories`
                              : `Add ${entry.name} as an additional directory`
                          }
                          className="size-10 md:size-9"
                          onClick={() => toggleAdditionalDirectory(entry)}
                          size="icon"
                          title={
                            additional
                              ? "Remove additional directory"
                              : "Add as an additional directory"
                          }
                          variant="ghost"
                        >
                          {additional ? (
                            <Check className="size-4 text-[#279a60]" />
                          ) : (
                            <FolderPlus className="size-4" />
                          )}
                        </Button>
                      )}
                      <Button
                        aria-label={`Use ${entry.name} as the primary directory`}
                        className="mr-1 h-9 px-2.5 text-[11px]"
                        onClick={() => choosePrimary(entry)}
                        size="sm"
                        variant="ghost"
                      >
                        Use
                      </Button>
                    </div>
                  );
                })}
              </div>
              <footer className="flex items-center justify-between gap-3 border-t-[0.5px] border-black/7 px-3 py-2">
                <span className="truncate text-[10px] text-muted-foreground">
                  {browser.entries.directoryLabel}
                </span>
                <Button
                  className="min-h-10 md:min-h-9"
                  onClick={() =>
                    choosePrimary({
                      directoryId: browser.entries.directoryId,
                      name: browser.entries.directoryLabel,
                    })
                  }
                  size="sm"
                >
                  Use this directory
                </Button>
              </footer>
            </>
          )}
        </section>
      )}
    </div>
  );
}
