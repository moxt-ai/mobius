import type { NativeSessionEntry, NativeSessionHistory, SessionCapabilities } from "@moxt-ai/mobius-sdk";
import { MobiusChannelError } from "@moxt-ai/mobius-sdk/channel";
import {
    ArrowLeft,
    ArrowRight,
    ChevronRight,
    CircleAlert,
    Eye,
    Folder,
    GitFork,
    History,
    Laptop,
    LoaderCircle,
    MessageSquare,
    MoreHorizontal,
    RefreshCw,
    Search,
    Trash2,
    X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { AgentProductIcon } from "@/components/agent-product-icon";
import { NativeSessionHistoryView } from "@/components/chat-message-list";
import { Button } from "@/components/ui/button";
import type { AgentOption } from "@/domain/channel";
import { cn } from "@/lib/utils";
import { sessionRoutePath } from "@/services/app-routes";
import { manageNativeSession, type NativeSessionScope } from "@/services/mobius-transport";
import { useChatStore } from "@/store/chat-store";

interface SessionPage {
    readonly capabilities: SessionCapabilities;
    readonly entries: readonly NativeSessionEntry[];
    readonly nextCursor: string | null;
    readonly notice: string;
}

interface PreviewState {
    readonly kind: "preview";
    readonly page: SessionPage;
    readonly entry: NativeSessionEntry;
    readonly history: NativeSessionHistory;
    readonly message: string | null;
}

type BrowserState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "ready"; readonly page: SessionPage }
    | { readonly kind: "loading-more"; readonly page: SessionPage }
    | {
          readonly kind: "page-failed";
          readonly page: SessionPage;
          readonly message: string;
      }
    | PreviewState
    | {
          readonly kind: "confirm-delete";
          readonly page: SessionPage;
          readonly entry: NativeSessionEntry;
      }
    | {
          readonly kind: "acting";
          readonly page: SessionPage;
          readonly entry: NativeSessionEntry;
          readonly action: "import" | "fork" | "delete";
          readonly previous: PreviewState | { readonly kind: "ready"; readonly page: SessionPage };
      }
    | {
          readonly kind: "action-failed";
          readonly page: SessionPage;
          readonly message: string;
          readonly entry: NativeSessionEntry;
          readonly action: "import" | "fork" | "delete";
          readonly recovery: "retry" | "refresh";
      };

function errorMessage(error: unknown): string {
    if (error instanceof MobiusChannelError) {
        switch (error.code) {
            case "acp_execution_failed":
                return "The Agent couldn’t complete this request. Try again.";
            case "native_history_unavailable":
                return "This session couldn’t be opened or previewed. Close it in the other app, then try again.";
            case "native_session_not_found":
            case "native_session_cursor_expired":
            case "native_session_target_changed":
                return "This session list is out of date. Refresh it to continue.";
        }
    }
    return error instanceof MobiusChannelError ? error.message : "Could not load sessions. Try again.";
}

function SessionActions({
    entry,
    capabilities,
    onFork,
    onDelete,
}: {
    readonly entry: NativeSessionEntry;
    readonly capabilities: SessionCapabilities;
    readonly onFork: () => void;
    readonly onDelete: () => void;
}) {
    const id = useId();
    const menuRef = useRef<HTMLFieldSetElement>(null);
    const [open, setOpen] = useState(false);
    if (!capabilities.unstableForkSession && !capabilities.deleteSession) {
        return null;
    }
    return (
        <>
            <Button
                aria-controls={id}
                aria-expanded={open}
                aria-label={`Actions for ${entry.title}`}
                className="size-11 rounded-lg text-muted-foreground hover:bg-black/5"
                size="icon"
                variant="ghost"
                onClick={(event) => {
                    const menu = menuRef.current;
                    if (menu === null) {
                        return;
                    }
                    if (open) {
                        menu.hidePopover();
                        return;
                    }
                    const anchor = event.currentTarget.getBoundingClientRect();
                    menu.showPopover();
                    const bounds = menu.getBoundingClientRect();
                    menu.style.left = `${Math.max(12, anchor.right - bounds.width)}px`;
                    menu.style.top = `${Math.max(12, Math.min(anchor.bottom + 4, window.innerHeight - bounds.height - 12))}px`;
                }}
            >
                <MoreHorizontal aria-hidden="true" className="size-4" />
            </Button>
            <fieldset
                aria-label={`Session actions for ${entry.title}`}
                className="fixed inset-auto m-0 w-[216px] rounded-[10px] border-[0.5px] border-black/10 bg-white p-1 text-foreground shadow-[0_10px_32px_rgba(0,0,0,0.12)]"
                id={id}
                onToggle={(event) => setOpen(event.newState === "open")}
                popover="auto"
                ref={menuRef}
            >
                {capabilities.unstableForkSession && (
                    <Button
                        className="min-h-11 w-full justify-start rounded-[7px] px-3 text-xs"
                        onClick={() => {
                            menuRef.current?.hidePopover();
                            onFork();
                        }}
                        variant="ghost"
                    >
                        <GitFork aria-hidden="true" className="size-3.5" /> Fork session{" "}
                        <span className="ml-auto text-[10px] text-muted-foreground">Experimental</span>
                    </Button>
                )}
                {capabilities.deleteSession && (
                    <Button
                        className="min-h-11 w-full justify-start rounded-[7px] px-3 text-xs text-destructive hover:bg-destructive/5 hover:text-destructive"
                        onClick={() => {
                            menuRef.current?.hidePopover();
                            onDelete();
                        }}
                        variant="ghost"
                    >
                        <Trash2 aria-hidden="true" className="size-3.5" /> Delete session
                    </Button>
                )}
            </fieldset>
        </>
    );
}

function NativeSessionList({
    agent,
    scope,
    onClose,
}: {
    readonly agent: AgentOption;
    readonly scope: NativeSessionScope;
    readonly onClose: () => void;
}) {
    const params = useParams<"channelId">();
    const channelId = params.channelId ?? "";
    const navigate = useNavigate();
    const requestRef = useRef<AbortController | null>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const previewTitleRef = useRef<HTMLHeadingElement>(null);
    const [state, setState] = useState<BrowserState>({ kind: "loading" });
    const [query, setQuery] = useState("");
    const page = "page" in state ? state.page : null;
    const load = useCallback(
        async (previous: SessionPage | null): Promise<void> => {
            requestRef.current?.abort();
            const controller = new AbortController();
            requestRef.current = controller;
            setState(previous === null ? { kind: "loading" } : { kind: "loading-more", page: previous });
            try {
                const result = await manageNativeSession(
                    scope,
                    { action: "list", cursor: previous?.nextCursor ?? null },
                    controller.signal,
                );
                controller.signal.throwIfAborted();
                if (result.action !== "list") {
                    throw new Error("Unexpected session result");
                }
                setState({
                    kind: "ready",
                    page: {
                        capabilities: result.capabilities,
                        entries: [...(previous?.entries ?? []), ...result.entries],
                        nextCursor: result.nextCursor,
                        notice: "",
                    },
                });
            } catch (error) {
                if (controller.signal.aborted) {
                    return;
                }
                setState(
                    previous === null
                        ? { kind: "failed", message: errorMessage(error) }
                        : {
                              kind: "page-failed",
                              page: previous,
                              message: errorMessage(error),
                          },
                );
            }
        },
        [scope],
    );

    useEffect(() => {
        void load(null);
        return () => requestRef.current?.abort();
    }, [load]);
    useEffect(() => {
        if (state.kind === "confirm-delete") {
            cancelRef.current?.focus();
        }
        if (state.kind === "preview") {
            previewTitleRef.current?.focus();
        }
    }, [state.kind]);

    const act = async (
        entry: NativeSessionEntry,
        action: "import" | "fork" | "delete",
        current: SessionPage,
        previous: PreviewState | { readonly kind: "ready"; readonly page: SessionPage } = {
            kind: "ready",
            page: current,
        },
    ): Promise<void> => {
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        setState({ kind: "acting", page: current, entry, action, previous });
        try {
            const result = await manageNativeSession(
                scope,
                { action, directoryId: entry.directoryId, entryId: entry.entryId },
                controller.signal,
            );
            controller.signal.throwIfAborted();
            if (result.action === "import" || result.action === "fork") {
                useChatStore.getState().openNativeConversation(result);
                await navigate(sessionRoutePath(channelId, result.ready.sessionId));
                onClose();
            } else if (result.action === "preview") {
                setState({
                    kind: "preview",
                    page: current,
                    entry,
                    history: result.history,
                    message: null,
                });
            } else if (result.action === "delete") {
                useChatStore.getState().applyNativeSessionDeletion(result.deletedSessionIds);
                setState({
                    kind: "ready",
                    page: {
                        ...current,
                        entries: current.entries.filter((candidate) => candidate.entryId !== entry.entryId),
                        notice: "Session deleted. Your Mobius history is retained.",
                    },
                });
            } else {
                throw new Error("Unexpected session result");
            }
        } catch (error) {
            if (controller.signal.aborted) {
                return;
            }
            if (previous.kind === "preview") {
                setState({ ...previous, message: errorMessage(error) });
                return;
            }
            setState({
                kind: "action-failed",
                page: current,
                message: errorMessage(error),
                entry,
                action,
                recovery:
                    error instanceof MobiusChannelError &&
                    (error.code === "native_session_not_found" ||
                        error.code === "native_session_cursor_expired" ||
                        error.code === "native_session_target_changed")
                        ? "refresh"
                        : "retry",
            });
        }
    };

    if (state.kind === "preview") {
        return (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="shrink-0 border-b-[0.5px] border-black/6 px-5 pt-2 pb-4">
                    <Button
                        className="-ml-2 min-h-11 px-2 text-xs text-muted-foreground"
                        variant="ghost"
                        onClick={() => setState({ kind: "ready", page: state.page })}
                    >
                        <ArrowLeft aria-hidden="true" className="size-3.5" /> All {agent.label} sessions
                    </Button>
                    <h3
                        className="line-clamp-2 text-sm leading-5 font-semibold outline-none"
                        ref={previewTitleRef}
                        tabIndex={-1}
                    >
                        {state.entry.title}
                    </h3>
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Eye aria-hidden="true" className="size-3.5" /> Saved history · Read only
                    </p>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground" title={state.entry.directoryLabel}>
                        {state.entry.directoryLabel}
                    </p>
                </div>
                <div className="conversation-scroll min-h-0 flex-1 overflow-y-auto px-5 py-5">
                    <NativeSessionHistoryView history={state.history} agentLabel={agent.label} />
                </div>
                <div className="shrink-0 border-t-[0.5px] border-black/6 px-5 py-3">
                    <p className="text-xs leading-5 text-copy-secondary" role="status">
                        {agent.label} couldn’t resume this session. Another app may still be using it. Close it there,
                        then continue here, or fork a separate conversation.
                    </p>
                    {state.message !== null && (
                        <p className="mt-2 text-xs leading-5 text-destructive" role="alert">
                            {state.message}
                        </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                        {state.page.capabilities.unstableForkSession && (
                            <Button
                                className="min-h-11 rounded-lg px-3 text-xs"
                                variant="ghost"
                                onClick={() => void act(state.entry, "fork", state.page, state)}
                            >
                                <GitFork aria-hidden="true" className="size-3.5" /> Fork session
                            </Button>
                        )}
                        <Button
                            className="min-h-11 rounded-lg px-3 text-xs"
                            variant="outline"
                            onClick={() => void act(state.entry, "import", state.page, state)}
                        >
                            <RefreshCw aria-hidden="true" className="size-3.5" /> Continue original
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    if (state.kind === "confirm-delete") {
        return (
            <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-1 flex-col justify-center px-6 py-8 sm:px-9" role="alert">
                    <span className="mb-4 flex size-10 items-center justify-center rounded-xl bg-destructive/5 text-destructive">
                        <Trash2 aria-hidden="true" className="size-[18px]" />
                    </span>
                    <h3 className="text-lg font-semibold tracking-[-0.02em]">Delete this session?</h3>
                    <p className="mt-3 line-clamp-3 text-sm leading-6 text-copy-secondary">{state.entry.title}</p>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                        This removes the saved session from {agent.label}. Messages already in Mobius remain available.
                        This cannot be undone.
                    </p>
                </div>
                <div className="flex justify-end gap-2 border-t-[0.5px] border-black/6 px-5 py-3">
                    <Button
                        className="min-h-11 rounded-lg text-xs"
                        onClick={() => setState({ kind: "ready", page: state.page })}
                        ref={cancelRef}
                        variant="ghost"
                    >
                        Keep session
                    </Button>
                    <Button
                        className="min-h-11 rounded-lg bg-destructive text-xs text-white hover:bg-destructive/90"
                        onClick={() => void act(state.entry, "delete", state.page)}
                    >
                        Delete session
                    </Button>
                </div>
            </div>
        );
    }

    if (state.kind === "acting") {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12" role="status">
                <LoaderCircle
                    aria-hidden="true"
                    className="size-5 animate-spin text-success motion-reduce:animate-none"
                />
                <p className="text-sm font-medium">
                    {state.action === "delete"
                        ? "Deleting session…"
                        : state.action === "fork"
                          ? "Creating a fork…"
                          : "Opening conversation…"}
                </p>
                <p className="max-w-[300px] truncate text-xs text-muted-foreground">{state.entry.title}</p>
                <Button
                    className="mt-2 min-h-11 text-xs"
                    onClick={() => {
                        requestRef.current?.abort();
                        setState(state.previous);
                    }}
                    variant="ghost"
                >
                    Cancel
                </Button>
            </div>
        );
    }

    const entries =
        page?.entries.filter((entry) =>
            `${entry.title} ${entry.directoryLabel}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        ) ?? [];
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="shrink-0 px-5 pt-5 pb-3">
                <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{agent.label} sessions</h3>
                    <span
                        className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                        title="Sessions across this machine’s projects"
                    >
                        <Folder aria-hidden="true" className="size-3.5 shrink-0" />
                        <span className="max-w-40 truncate">All projects</span>
                    </span>
                </div>
                <label className="mt-4 flex min-h-11 items-center gap-2 rounded-lg border-[0.5px] border-black/9 bg-background px-3 focus-within:ring-2 focus-within:ring-ring/50">
                    <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="sr-only">Filter loaded sessions</span>
                    <input
                        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        placeholder="Filter by title or project…"
                        type="search"
                        value={query}
                    />
                </label>
            </div>
            <div
                aria-busy={state.kind === "loading" || state.kind === "loading-more"}
                className="conversation-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3"
            >
                {state.kind === "loading" && (
                    <div
                        className="flex min-h-56 items-center justify-center gap-2 text-xs text-muted-foreground"
                        role="status"
                    >
                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                        Loading {agent.label} sessions…
                    </div>
                )}
                {(state.kind === "failed" || state.kind === "page-failed") && (
                    <div
                        className="mx-2 my-3 flex items-start gap-3 rounded-lg border-[0.5px] border-black/8 px-3 py-2"
                        role="alert"
                    >
                        <CircleAlert aria-hidden="true" className="mt-3 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1 py-1.5">
                            <p className="text-xs font-medium">
                                Couldn’t load {state.kind === "page-failed" ? "more " : ""}
                                sessions
                            </p>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{state.message}</p>
                        </div>
                        <Button
                            className="min-h-11 shrink-0 px-2 text-xs"
                            onClick={() => void load(state.kind === "page-failed" ? state.page : null)}
                            variant="ghost"
                        >
                            Retry
                        </Button>
                    </div>
                )}
                {page?.notice && (
                    <p
                        className="mx-2 mb-2 rounded-lg bg-success-subtle px-3 py-2 text-xs leading-5 text-success"
                        role="status"
                    >
                        {page.notice}
                    </p>
                )}
                {page !== null && entries.length === 0 && (
                    <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
                        <MessageSquare aria-hidden="true" className="mb-3 size-6 text-muted-foreground/50" />
                        <p className="text-sm font-medium">
                            {query.length > 0 ? "No matching sessions" : "No saved sessions yet"}
                        </p>
                        <p className="mt-2 max-w-64 text-xs leading-5 text-muted-foreground">
                            {query.length > 0
                                ? page.nextCursor === null
                                    ? "Try a different title."
                                    : "Try another title or load more sessions below."
                                : `${agent.label} sessions from this machine will appear here.`}
                        </p>
                    </div>
                )}
                {page !== null && entries.length > 0 && (
                    <ul aria-label={`${agent.label} saved sessions`} className="space-y-1">
                        {entries.map((entry) => (
                            <li
                                className="group rounded-[9px] transition-colors duration-150 hover:bg-black/[0.035] focus-within:bg-black/[0.035]"
                                key={entry.entryId}
                            >
                                <div className="flex items-center gap-1 pr-1">
                                    <button
                                        aria-label={`Open ${entry.title}`}
                                        className="flex min-h-[72px] min-w-0 flex-1 items-center gap-3 rounded-[9px] px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default"
                                        disabled={!page.capabilities.loadSession && !page.capabilities.resumeSession}
                                        onClick={() => void act(entry, "import", page)}
                                        title={entry.title}
                                        type="button"
                                    >
                                        <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] border-[0.5px] border-black/7 bg-white text-muted-foreground">
                                            <MessageSquare aria-hidden="true" className="size-3.5" />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="line-clamp-2 text-[13px] leading-[19px] font-medium text-foreground">
                                                {entry.title}
                                            </span>
                                            <span className="mt-1 block truncate text-[11px] leading-4 text-muted-foreground">
                                                <span className="block truncate" title={entry.directoryLabel}>
                                                    {entry.directoryLabel}
                                                </span>
                                                {entry.updatedAt === null
                                                    ? "Saved session"
                                                    : new Date(entry.updatedAt).toLocaleString(undefined, {
                                                          month: "short",
                                                          day: "numeric",
                                                          hour: "2-digit",
                                                          minute: "2-digit",
                                                      })}
                                                {entry.additionalDirectories.length > 0 &&
                                                    ` · +${entry.additionalDirectories.length.toString()} folders`}
                                            </span>
                                        </span>
                                        <ArrowRight
                                            aria-hidden="true"
                                            className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
                                        />
                                    </button>
                                    <SessionActions
                                        capabilities={page.capabilities}
                                        entry={entry}
                                        onDelete={() => setState({ kind: "confirm-delete", page, entry })}
                                        onFork={() => void act(entry, "fork", page)}
                                    />
                                </div>
                                {state.kind === "action-failed" && state.entry.entryId === entry.entryId && (
                                    <div
                                        className="mr-3 mb-2 ml-14 flex items-start gap-2 border-t-[0.5px] border-black/6 pt-2"
                                        role="alert"
                                    >
                                        <CircleAlert
                                            aria-hidden="true"
                                            className="mt-1 size-3.5 shrink-0 text-destructive"
                                        />
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs font-medium">
                                                Couldn’t{" "}
                                                {state.action === "delete"
                                                    ? "delete"
                                                    : state.action === "fork"
                                                      ? "fork"
                                                      : "open"}{" "}
                                                this session
                                            </p>
                                            <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                                {state.message}
                                            </p>
                                        </div>
                                        <Button
                                            className="min-h-11 shrink-0 px-2 text-xs"
                                            variant="ghost"
                                            onClick={() =>
                                                state.recovery === "refresh"
                                                    ? void load(null)
                                                    : void act(state.entry, state.action, state.page)
                                            }
                                        >
                                            {state.recovery === "refresh" ? "Refresh" : "Retry"}
                                        </Button>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div className="flex min-h-14 shrink-0 items-center gap-2 border-t-[0.5px] border-black/6 px-5 py-1.5">
                <span className="text-[11px] text-muted-foreground">
                    {page === null
                        ? "From your local machine"
                        : `${page.entries.length.toString()} sessions${page.nextCursor !== null ? " loaded" : ""}`}
                </span>
                <Button
                    aria-label={`Refresh ${agent.label} sessions`}
                    className="ml-auto size-11 rounded-lg text-muted-foreground"
                    disabled={state.kind === "loading" || state.kind === "loading-more"}
                    onClick={() => void load(null)}
                    size="icon"
                    title="Refresh sessions"
                    variant="ghost"
                >
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                </Button>
                {page?.nextCursor != null && (
                    <Button
                        className="min-h-11 rounded-lg px-2 text-xs"
                        disabled={state.kind === "loading-more"}
                        onClick={() => void load(page)}
                        variant="ghost"
                    >
                        {state.kind === "loading-more" ? "Loading…" : "Load more"}
                        <ChevronRight aria-hidden="true" className="size-3.5" />
                    </Button>
                )}
            </div>
        </div>
    );
}

function NativeSessionDialog({ browserId, onClose }: { readonly browserId: string; readonly onClose: () => void }) {
    const agents = useChatStore((state) => state.agents);
    const machineName = useChatStore((state) => state.machineName);
    const dialogRef = useRef<HTMLDialogElement>(null);
    const close = useCallback(() => {
        dialogRef.current?.close();
        onClose();
    }, [onClose]);
    const [selection, setSelection] = useState<{
        readonly agent: AgentOption;
        readonly scope: NativeSessionScope;
    } | null>(null);
    useEffect(() => {
        const dialog = dialogRef.current;
        dialog?.showModal();
        return () => dialog?.close();
    }, []);
    return (
        <dialog
            aria-describedby="native-sessions-description"
            aria-labelledby="native-sessions-title"
            className="fixed inset-0 m-auto h-[min(620px,calc(100dvh-32px))] max-h-none w-[min(800px,calc(100vw-32px))] max-w-none overflow-hidden rounded-[16px] border-[0.5px] border-black/10 bg-white p-0 text-foreground shadow-[0_24px_100px_rgba(0,0,0,0.18)] backdrop:bg-black/25 backdrop:backdrop-blur-[2px] max-sm:h-[calc(100dvh-24px)] max-sm:w-[calc(100vw-24px)]"
            onCancel={(event) => {
                event.preventDefault();
                close();
            }}
            onClose={onClose}
            ref={dialogRef}
        >
            <div className="flex h-full min-h-0 flex-col">
                <header className="flex min-h-16 shrink-0 items-center gap-3 border-b-[0.5px] border-black/7 px-5">
                    <span className="flex size-8 items-center justify-center rounded-[9px] bg-success-subtle text-success">
                        <History aria-hidden="true" className="size-4" />
                    </span>
                    <div>
                        <h2 className="text-sm font-semibold tracking-[-0.01em]" id="native-sessions-title">
                            Local sessions
                        </h2>
                        <p className="mt-0.5 text-[11px] text-muted-foreground" id="native-sessions-description">
                            Pick an Agent. Continue where you left off.
                        </p>
                    </div>
                    <Button
                        aria-label="Close local sessions"
                        className="ml-auto size-11 rounded-lg text-muted-foreground"
                        onClick={close}
                        size="icon"
                        variant="ghost"
                    >
                        <X aria-hidden="true" className="size-4" />
                    </Button>
                </header>
                <div className="flex min-h-0 flex-1 max-sm:flex-col">
                    <nav
                        aria-label="Local Agents"
                        className="flex w-[180px] shrink-0 flex-col border-r-[0.5px] border-black/7 bg-sidebar px-2.5 pt-4 pb-3 max-sm:w-auto max-sm:border-r-0 max-sm:border-b-[0.5px] max-sm:px-3 max-sm:py-2"
                    >
                        <p className="mb-2 px-2.5 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase max-sm:sr-only">
                            Local Agents
                        </p>
                        <div className="space-y-1 max-sm:flex max-sm:gap-1 max-sm:space-y-0 max-sm:overflow-x-auto">
                            {agents.map((agent) => (
                                <Button
                                    aria-pressed={selection?.agent.id === agent.id}
                                    className={cn(
                                        "min-h-11 w-full justify-start gap-2.5 rounded-[9px] px-2.5 text-xs hover:bg-black/5 max-sm:w-auto max-sm:shrink-0 max-sm:px-3",
                                        selection?.agent.id === agent.id &&
                                            "bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),inset_0_0_0_0.5px_rgba(0,0,0,0.09)] hover:bg-white",
                                    )}
                                    key={agent.id}
                                    onClick={() => {
                                        if (selection?.agent.id !== agent.id) {
                                            setSelection({
                                                agent,
                                                scope: {
                                                    agentId: agent.id,
                                                    directoryId: "default",
                                                    sessionId: `${browserId}:${agent.id}`,
                                                },
                                            });
                                        }
                                    }}
                                    variant="ghost"
                                >
                                    <AgentProductIcon agentId={agent.id} agentLabel={agent.label} />
                                    {agent.label}
                                </Button>
                            ))}
                        </div>
                        <div className="mt-auto flex items-center gap-1.5 px-2.5 pt-5 text-[10px] text-muted-foreground max-sm:hidden">
                            <Laptop aria-hidden="true" className="size-3.5 shrink-0" />
                            <span className="truncate" title={machineName}>
                                {machineName}
                            </span>
                        </div>
                    </nav>
                    {selection === null ? (
                        <div className="flex min-w-0 flex-1 flex-col items-center justify-center px-8 py-12 text-center">
                            <div className="mb-5 flex items-center -space-x-1.5">
                                {agents.map((agent) => (
                                    <span
                                        className="flex size-11 items-center justify-center rounded-xl border-[0.5px] border-black/9 bg-white shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
                                        key={agent.id}
                                    >
                                        <AgentProductIcon
                                            agentId={agent.id}
                                            agentLabel={agent.label}
                                            className="size-7 rounded-lg"
                                        />
                                    </span>
                                ))}
                            </div>
                            <h3 className="text-lg font-semibold tracking-[-0.025em]">Choose a local Agent</h3>
                            <p className="mt-2 max-w-64 text-xs leading-5 text-muted-foreground">
                                Each Agent has its own saved sessions. Select one to browse conversations across this
                                machine’s projects.
                            </p>
                        </div>
                    ) : (
                        <NativeSessionList
                            agent={selection.agent}
                            key={selection.scope.sessionId}
                            onClose={close}
                            scope={selection.scope}
                        />
                    )}
                </div>
            </div>
        </dialog>
    );
}

export function NativeSessionBrowser() {
    const agents = useChatStore((state) => state.agents);
    const runtime = useChatStore((state) => state.runtime);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [browserId] = useState(() => crypto.randomUUID());
    const [open, setOpen] = useState(false);
    const close = useCallback(() => {
        setOpen(false);
        triggerRef.current?.focus();
    }, []);
    return (
        <>
            <Button
                className="mt-1 min-h-11 w-full justify-start gap-2.5 rounded-[9px] px-2.5 text-[13px] text-copy-secondary hover:bg-black/5"
                disabled={!runtime.canSend || agents.length === 0}
                onClick={() => setOpen(true)}
                ref={triggerRef}
                variant="ghost"
            >
                <History aria-hidden="true" className="size-[17px]" />
                Local sessions
            </Button>
            {open && <NativeSessionDialog browserId={browserId} onClose={close} />}
        </>
    );
}
