import type { WorkspaceEntriesEvent, WorkspaceEntry } from "@moxt-ai/mobius-sdk";
import {
    Check,
    ChevronLeft,
    ChevronRight,
    Folder,
    FolderOpen,
    FolderPlus,
    FolderSearch,
    Home,
    LoaderCircle,
    Search,
    X,
} from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listWorkspace } from "@/services/mobius-transport";
import {
    placeWorkspacePickerPanel,
    type WorkspacePickerPanelPlacement,
    workspacePickerPanelMode,
} from "@/services/workspace-picker-panel-placement";
import { filterWorkspaceEntries } from "@/services/workspace-picker-presentation";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

const FOCUSABLE_CONTROL_SELECTOR = [
    "button:not([disabled])",
    "[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
].join(",");

type WorkspacePickerPanelLayout =
    | { readonly kind: "pending" }
    | { readonly kind: "sheet" }
    | WorkspacePickerPanelPlacement;

const PENDING_PANEL_LAYOUT: WorkspacePickerPanelLayout = { kind: "pending" };

function panelStyle(layout: WorkspacePickerPanelLayout): CSSProperties | undefined {
    if (layout.kind === "pending" || layout.kind === "sheet") {
        return undefined;
    }
    if (layout.kind === "above") {
        return {
            bottom: layout.bottom,
            left: layout.left,
            maxHeight: layout.maxHeight,
            width: layout.width,
        };
    }
    return {
        left: layout.left,
        maxHeight: layout.maxHeight,
        top: layout.top,
        width: layout.width,
    };
}

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
    return error instanceof Error ? error.message : "The directory could not be loaded.";
}

interface WorkspacePickerControlProps {
    readonly additionalDirectories: readonly WorkspaceEntry[];
    readonly canAddAdditionalDirectories: boolean;
    readonly directoryId: string;
    readonly directoryLabel: string;
    readonly listDirectories: (directoryId: string, signal: AbortSignal) => Promise<WorkspaceEntriesEvent>;
    readonly locked: boolean;
    readonly onFailure: (message: string) => void;
    readonly onSelectPrimary: (directory: WorkspaceEntry) => Promise<void>;
    readonly onToggleAdditional: (directory: WorkspaceEntry) => void;
}

function WorkspacePickerControl({
    additionalDirectories,
    canAddAdditionalDirectories,
    directoryId,
    directoryLabel,
    listDirectories,
    locked,
    onFailure,
    onSelectPrimary,
    onToggleAdditional,
}: WorkspacePickerControlProps) {
    const [browser, setBrowser] = useState<DirectoryBrowserState>(new ClosedDirectoryBrowserState());
    const [panelLayout, setPanelLayout] = useState<WorkspacePickerPanelLayout>(PENDING_PANEL_LAYOUT);
    const [searchQuery, setSearchQuery] = useState("");
    const [selecting, setSelecting] = useState(false);
    const panelId = useId();
    const panelRef = useRef<HTMLElement>(null);
    const requestControllerRef = useRef<AbortController>(null);
    const requestSequenceRef = useRef(0);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const load = (directoryId: string): void => {
        requestControllerRef.current?.abort();
        const controller = new AbortController();
        requestControllerRef.current = controller;
        const requestSequence = requestSequenceRef.current + 1;
        requestSequenceRef.current = requestSequence;
        setSearchQuery("");
        setBrowser(new LoadingDirectoryBrowserState(directoryId));
        void listDirectories(directoryId, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]))
            .then((entries) => {
                if (requestSequenceRef.current !== requestSequence) {
                    return;
                }
                setBrowser(new LoadedDirectoryBrowserState(entries));
                onFailure("");
            })
            .catch((error: unknown) => {
                if (requestSequenceRef.current !== requestSequence) {
                    return;
                }
                const message = browserFailure(error);
                setBrowser(new FailedDirectoryBrowserState(directoryId, message));
                onFailure(message);
            });
    };

    const close = useCallback((): void => {
        requestControllerRef.current?.abort();
        requestSequenceRef.current += 1;
        setBrowser(new ClosedDirectoryBrowserState());
        setPanelLayout(PENDING_PANEL_LAYOUT);
        setSearchQuery("");
        triggerRef.current?.focus();
    }, []);

    const choosePrimary = async (directory: WorkspaceEntry): Promise<void> => {
        setSelecting(true);
        try {
            await onSelectPrimary(directory);
            onFailure("");
            close();
        } catch (error) {
            const message = browserFailure(error);
            setBrowser(new FailedDirectoryBrowserState(directory.directoryId, message));
            onFailure(message);
        } finally {
            setSelecting(false);
        }
    };

    useLayoutEffect(() => {
        if (!browser.open) {
            return;
        }
        const trigger = triggerRef.current;
        if (trigger === null) {
            return;
        }
        const updateLayout = (): void => {
            if (
                workspacePickerPanelMode({
                    viewportHeight: window.innerHeight,
                    viewportWidth: window.innerWidth,
                }) === "sheet"
            ) {
                setPanelLayout({ kind: "sheet" });
                return;
            }
            const anchor = trigger.getBoundingClientRect();
            setPanelLayout(
                placeWorkspacePickerPanel({
                    anchorBottom: anchor.bottom,
                    anchorLeft: anchor.left,
                    anchorTop: anchor.top,
                    viewportHeight: window.innerHeight,
                    viewportWidth: window.innerWidth,
                }),
            );
        };
        updateLayout();
        const controller = new AbortController();
        window.addEventListener("resize", updateLayout, {
            signal: controller.signal,
        });
        return () => controller.abort();
    }, [browser.open]);

    useEffect(() => {
        if (!browser.open) {
            return;
        }
        const focusFrame = window.requestAnimationFrame(() => {
            panelRef.current?.focus({ preventScroll: true });
        });
        const controller = new AbortController();
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    close();
                    return;
                }
                if (event.key !== "Tab" || panelRef.current === null) {
                    return;
                }
                const controls = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_CONTROL_SELECTOR));
                const first = controls[0];
                const last = controls.at(-1);
                const activeElement = document.activeElement;
                if (first === undefined || last === undefined) {
                    event.preventDefault();
                    panelRef.current.focus({ preventScroll: true });
                    return;
                }
                if (event.shiftKey && (activeElement === first || activeElement === panelRef.current)) {
                    event.preventDefault();
                    last.focus({ preventScroll: true });
                } else if (!event.shiftKey && activeElement === last) {
                    event.preventDefault();
                    first.focus({ preventScroll: true });
                }
            },
            { signal: controller.signal },
        );
        return () => {
            window.cancelAnimationFrame(focusFrame);
            controller.abort();
        };
    }, [browser.open, close]);

    useEffect(
        () => () => {
            requestControllerRef.current?.abort();
            requestSequenceRef.current += 1;
        },
        [],
    );

    const visibleEntries =
        browser instanceof LoadedDirectoryBrowserState
            ? filterWorkspaceEntries(browser.entries.entries, searchQuery)
            : [];

    return (
        <div className={cn("relative min-w-0", locked && "max-sm:hidden")}>
            <Button
                aria-controls={panelId}
                aria-expanded={browser.open}
                aria-haspopup="dialog"
                aria-label={`Workspace directory: ${directoryLabel}`}
                className="h-11 w-11 shrink-0 justify-center rounded-full border-0 bg-transparent px-0 text-xs font-medium text-muted-foreground shadow-none hover:bg-black/[0.04] hover:text-foreground lg:h-9 lg:w-auto lg:max-w-[180px] lg:justify-start lg:bg-black/[0.035] lg:px-2.5"
                disabled={locked}
                onClick={() => {
                    if (browser.open) {
                        close();
                    } else {
                        setPanelLayout(PENDING_PANEL_LAYOUT);
                        load("home");
                    }
                }}
                ref={triggerRef}
                title={
                    locked
                        ? "The workspace is fixed after the first message"
                        : `Choose workspace directory · ${directoryLabel}`
                }
                variant="outline"
            >
                <FolderOpen className="size-4 shrink-0 text-success" />
                <span className="sr-only lg:not-sr-only lg:truncate">{directoryLabel}</span>
            </Button>
            {browser.open && (
                <>
                    <button
                        aria-label="Close directory browser"
                        className={cn(
                            "fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px]",
                            panelLayout.kind !== "sheet" && "md:bg-transparent md:backdrop-blur-none",
                        )}
                        onClick={close}
                        type="button"
                    />
                    <section
                        aria-busy={browser instanceof LoadingDirectoryBrowserState}
                        aria-describedby={`${panelId}-description`}
                        aria-labelledby={`${panelId}-title`}
                        aria-modal="true"
                        className={cn(
                            "mobile-safe-sheet fixed inset-x-3 bottom-3 z-40 flex max-h-[min(82vh,660px)] flex-col overflow-hidden rounded-2xl border-[0.5px] border-black/10 bg-white shadow-[0_24px_80px_rgba(0,0,0,0.24)] outline-none md:shadow-[0_18px_54px_rgba(0,0,0,0.16)]",
                            panelLayout.kind !== "sheet" && "md:inset-auto md:max-h-none md:max-w-none",
                            panelLayout.kind === "pending" && "md:invisible",
                        )}
                        data-placement={panelLayout.kind}
                        data-workspace-picker-panel=""
                        id={panelId}
                        ref={panelRef}
                        role="dialog"
                        style={panelStyle(panelLayout)}
                        tabIndex={-1}
                    >
                        <header className="flex shrink-0 items-start gap-3 border-b-[0.5px] border-black/7 px-4 py-3.5">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success-subtle text-success">
                                <FolderOpen className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <h2
                                    className="text-sm font-semibold tracking-[-0.01em] text-foreground"
                                    id={`${panelId}-title`}
                                >
                                    Choose workspace
                                </h2>
                                <p
                                    className="mt-0.5 text-[11px] leading-4 text-muted-foreground"
                                    id={`${panelId}-description`}
                                >
                                    Choose the main folder for this conversation.
                                </p>
                            </div>
                            <Button
                                aria-label="Close directory browser"
                                className="-mt-1 -mr-1 size-11 rounded-full lg:size-9"
                                onClick={close}
                                size="icon"
                                variant="ghost"
                            >
                                <X className="size-4" />
                            </Button>
                        </header>
                        <nav
                            aria-label="Directory shortcuts"
                            className="flex shrink-0 gap-1 border-b-[0.5px] border-black/7 px-3 py-1.5"
                        >
                            <Button className="min-h-11 gap-2 text-xs" onClick={() => load("home")} variant="ghost">
                                <Home aria-hidden="true" className="size-3.5" />
                                Home
                            </Button>
                            <Button className="min-h-11 gap-2 text-xs" onClick={() => load("default")} variant="ghost">
                                <FolderOpen aria-hidden="true" className="size-3.5" />
                                Default workspace
                            </Button>
                        </nav>
                        {browser instanceof LoadingDirectoryBrowserState && (
                            <div
                                aria-live="polite"
                                className="flex min-h-52 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
                            >
                                <span className="flex size-10 items-center justify-center rounded-xl bg-surface-subtle text-muted-foreground">
                                    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                                </span>
                                <span className="text-xs font-medium text-copy-secondary">Opening folder…</span>
                            </div>
                        )}
                        {browser instanceof FailedDirectoryBrowserState && (
                            <div className="flex min-h-52 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8 text-center">
                                <span className="flex size-10 items-center justify-center rounded-xl bg-destructive/8 text-destructive">
                                    <FolderSearch className="size-4" />
                                </span>
                                <p className="mt-3 text-xs font-medium text-destructive">Couldn’t open this folder</p>
                                <p className="mt-1 max-w-72 text-[11px] leading-4 text-muted-foreground">
                                    {browser.message}
                                </p>
                                <Button
                                    className="mt-4 min-h-11 rounded-lg lg:min-h-9"
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
                                <div className="shrink-0 border-b-[0.5px] border-black/7 bg-surface-subtle/65 px-3 py-3">
                                    <div className="flex items-center gap-2">
                                        {browser.entries.parentDirectoryId.length > 0 && (
                                            <Button
                                                aria-label="Open parent directory"
                                                className="size-11 rounded-xl bg-white shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)] lg:size-10"
                                                onClick={() => {
                                                    load(browser.entries.parentDirectoryId);
                                                }}
                                                size="icon"
                                                title="Back to parent folder"
                                                variant="ghost"
                                            >
                                                <ChevronLeft className="size-4" />
                                            </Button>
                                        )}
                                        <div className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl bg-white px-3 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.09)] lg:h-10">
                                            <FolderOpen className="size-4 shrink-0 text-success" />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-[9px] font-semibold tracking-[0.08em] text-copy-tertiary uppercase">
                                                    Browsing
                                                </p>
                                                <p className="truncate text-xs font-medium text-copy-secondary">
                                                    {browser.entries.directoryLabel}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                    <label className="relative mt-2.5 block">
                                        <span className="sr-only">Search folders</span>
                                        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-copy-tertiary" />
                                        <input
                                            className="h-11 w-full appearance-none rounded-xl border-[0.5px] border-black/10 bg-white pr-10 pl-9 text-xs text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/15 motion-reduce:transition-none lg:h-10 [&::-webkit-search-cancel-button]:hidden"
                                            onChange={(event) => setSearchQuery(event.currentTarget.value)}
                                            placeholder="Search folders…"
                                            type="search"
                                            value={searchQuery}
                                        />
                                        {searchQuery.length > 0 && (
                                            <Button
                                                aria-label="Clear folder search"
                                                className="absolute top-0 right-0 size-11 rounded-xl lg:size-10"
                                                onClick={() => setSearchQuery("")}
                                                size="icon"
                                                variant="ghost"
                                            >
                                                <X className="size-3.5" />
                                            </Button>
                                        )}
                                    </label>
                                </div>
                                <ul
                                    aria-label={`Folders in ${browser.entries.directoryLabel}`}
                                    className="conversation-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
                                >
                                    {visibleEntries.length === 0 && (
                                        <li className="flex min-h-40 flex-col items-center justify-center px-6 py-8 text-center">
                                            <span className="flex size-10 items-center justify-center rounded-xl bg-surface-subtle text-copy-tertiary">
                                                <FolderSearch className="size-4" />
                                            </span>
                                            <p className="mt-3 text-xs font-medium text-copy-secondary">
                                                {searchQuery.trim().length > 0
                                                    ? "No matching folders"
                                                    : "No folders here"}
                                            </p>
                                            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                                                {searchQuery.trim().length > 0
                                                    ? "Try a different folder name."
                                                    : "This folder has no subfolders."}
                                            </p>
                                        </li>
                                    )}
                                    {visibleEntries.map((entry) => {
                                        const additional = additionalDirectories.some(
                                            (directory) => directory.directoryId === entry.directoryId,
                                        );
                                        return (
                                            <li
                                                className="group flex min-h-11 items-center gap-1 rounded-xl px-1 transition-colors duration-150 hover:bg-surface-subtle motion-reduce:transition-none lg:min-h-10"
                                                key={entry.directoryId}
                                            >
                                                <button
                                                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70 lg:min-h-10"
                                                    onClick={() => load(entry.directoryId)}
                                                    type="button"
                                                >
                                                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-black/[0.035] text-muted-foreground transition-colors duration-150 group-hover:bg-white motion-reduce:transition-none">
                                                        <Folder className="size-3.5" />
                                                    </span>
                                                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-copy-secondary">
                                                        {entry.name}
                                                    </span>
                                                    <ChevronRight className="size-3.5 shrink-0 text-copy-tertiary" />
                                                </button>
                                                {canAddAdditionalDirectories && (
                                                    <Button
                                                        aria-label={
                                                            additional
                                                                ? `Remove ${entry.name} from additional directories`
                                                                : `Add ${entry.name} as an additional directory`
                                                        }
                                                        aria-pressed={additional}
                                                        className={cn(
                                                            "h-11 rounded-lg px-2.5 text-[11px] shadow-none lg:h-9",
                                                            additional &&
                                                                "bg-success-subtle text-success hover:bg-success-subtle/80 hover:text-success",
                                                        )}
                                                        onClick={() => onToggleAdditional(entry)}
                                                        title={
                                                            additional
                                                                ? "Remove from conversation context"
                                                                : "Add to conversation context"
                                                        }
                                                        variant="ghost"
                                                    >
                                                        {additional ? (
                                                            <Check className="size-3.5" />
                                                        ) : (
                                                            <FolderPlus className="size-3.5" />
                                                        )}
                                                        <span>{additional ? "Added" : "Add context"}</span>
                                                    </Button>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                                <footer className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-t-[0.5px] border-black/7 bg-surface-subtle/45 px-4 py-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[9px] font-semibold tracking-[0.08em] text-copy-tertiary uppercase">
                                            Main workspace
                                        </p>
                                        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs font-medium text-copy-secondary">
                                            <Folder className="size-3.5 shrink-0 text-success" />
                                            <span className="truncate">{browser.entries.directoryLabel}</span>
                                        </p>
                                    </div>
                                    <Button
                                        className="min-h-11 rounded-lg px-4 text-xs disabled:opacity-100 lg:min-h-9"
                                        disabled={selecting || browser.entries.directoryId === directoryId}
                                        onClick={() =>
                                            void choosePrimary({
                                                directoryId: browser.entries.directoryId,
                                                name: browser.entries.directoryLabel,
                                            })
                                        }
                                        size="sm"
                                        variant={browser.entries.directoryId === directoryId ? "secondary" : "default"}
                                    >
                                        {browser.entries.directoryId === directoryId ? (
                                            <>
                                                <Check className="size-3.5" />
                                                Current workspace
                                            </>
                                        ) : (
                                            "Use this folder"
                                        )}
                                    </Button>
                                </footer>
                            </>
                        )}
                    </section>
                </>
            )}
        </div>
    );
}

export function WorkspacePicker() {
    const conversation = useChatStore(selectActiveConversation);
    const agent = useChatStore((state) => state.agents.find((candidate) => candidate.id === conversation.agentId));
    const selectPrimaryDirectory = useChatStore((state) => state.selectPrimaryDirectory);
    const setErrorMessage = useChatStore((state) => state.setErrorMessage);
    const toggleAdditionalDirectory = useChatStore((state) => state.toggleAdditionalDirectory);
    return (
        <WorkspacePickerControl
            additionalDirectories={conversation.additionalDirectories}
            canAddAdditionalDirectories={
                conversation.isDraft
                    ? (agent?.capabilities.additionalDirectories ?? false)
                    : conversation.session.capabilities.additionalDirectories
            }
            directoryId={conversation.directoryId}
            directoryLabel={conversation.directoryLabel}
            listDirectories={listWorkspace}
            locked={conversation.contextLocked || conversation.isRunning}
            onFailure={setErrorMessage}
            onSelectPrimary={(directory) => {
                selectPrimaryDirectory(directory);
                return Promise.resolve();
            }}
            onToggleAdditional={toggleAdditionalDirectory}
        />
    );
}
