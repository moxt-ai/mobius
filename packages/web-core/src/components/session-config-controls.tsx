import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";
import { Check, ChevronDown, LoaderCircle, RefreshCw, Settings2, X } from "lucide-react";
import { type CSSProperties, Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { ReadySessionState, SessionPreparationFailedState } from "@/domain/chat";
import { cn } from "@/lib/utils";
import { configureSessionOption, prepareActiveSession } from "@/services/mobius-transport";
import { sessionConfigPanelKeyAction } from "@/services/session-config-panel-keyboard";
import {
    placeSessionConfigPanel,
    type SessionConfigPanelPlacement,
    sessionConfigPanelMode,
} from "@/services/session-config-panel-placement";
import {
    groupSessionConfigOptions,
    isRequiredSessionConfigOption,
    summarizeSessionConfig,
} from "@/services/session-config-presentation";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

const FOCUSABLE_CONTROL_SELECTOR = [
    "button:not([disabled])",
    "[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
].join(",");

type SessionConfigPanelLayout = { readonly kind: "pending" } | { readonly kind: "sheet" } | SessionConfigPanelPlacement;

const PENDING_PANEL_LAYOUT: SessionConfigPanelLayout = { kind: "pending" };

function panelStyle(layout: SessionConfigPanelLayout): CSSProperties | undefined {
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

interface ConfigControlProps {
    readonly disabled: boolean;
    readonly onConfigure: (option: SessionConfigOption, value: string, booleanValue: boolean) => Promise<string>;
    readonly option: SessionConfigOption;
    readonly pending: boolean;
    readonly setPending: (id: string, pending: boolean) => void;
}

interface ConfigValueGroup {
    readonly id: string;
    readonly label: string;
    readonly values: SessionConfigOption["values"][number][];
}

function groupConfigValues(values: SessionConfigOption["values"]): readonly ConfigValueGroup[] {
    const groups = new Map<string, ConfigValueGroup>();
    for (const value of values) {
        const groupId = value.groupId.trim();
        const groupName = value.groupName.trim();
        const id = groupId.length > 0 ? `id:${groupId}` : groupName.length > 0 ? `name:${groupName}` : "ungrouped";
        const existing = groups.get(id);
        if (existing === undefined) {
            groups.set(id, {
                id,
                label: groupName.length > 0 ? groupName : groupId,
                values: [value],
            });
            continue;
        }
        existing.values.push(value);
    }
    return Array.from(groups.values());
}

function SelectConfigControl({
    disabled: controlDisabled,
    onConfigure,
    option,
    pending,
    setPending,
}: ConfigControlProps) {
    const labelId = useId();
    const descriptionId = useId();
    const errorId = useId();
    const [failure, setFailure] = useState("");
    const disabled = controlDisabled || pending || option.values.length < 2;
    const valueGroups = groupConfigValues(option.values);
    const describedBy = [option.description.length > 0 ? descriptionId : "", failure.length > 0 ? errorId : ""]
        .filter((id) => id.length > 0)
        .join(" ");

    return (
        <div className="grid grid-cols-[minmax(0,1fr)_148px] items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground" id={labelId}>
                    {option.name}
                </p>
                {isRequiredSessionConfigOption(option) && (
                    <span
                        aria-hidden="true"
                        className="mt-1 inline-flex rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.04em] text-primary uppercase"
                    >
                        Required
                    </span>
                )}
                {option.description.length > 0 && (
                    <p className="mt-0.5 text-[11px] leading-[17px] text-muted-foreground" id={descriptionId}>
                        {option.description}
                    </p>
                )}
            </div>
            <Select
                disabled={disabled}
                onValueChange={(value) => {
                    if (value === option.currentValue) {
                        return;
                    }
                    setFailure("");
                    setPending(option.id, true);
                    void onConfigure(option, value, false)
                        .then(setFailure)
                        .finally(() => {
                            setPending(option.id, false);
                        });
                }}
                value={option.currentValue}
            >
                <SelectTrigger
                    aria-describedby={describedBy.length > 0 ? describedBy : undefined}
                    aria-labelledby={labelId}
                    className="h-11 w-full min-w-0 justify-between rounded-lg bg-surface-subtle px-3 lg:h-10"
                >
                    <SelectValue />
                    {pending && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}
                </SelectTrigger>
                <SelectContent>
                    {valueGroups.map((group, index) => (
                        <Fragment key={group.id}>
                            {index > 0 && <SelectSeparator />}
                            {group.label.length > 0 ? (
                                <SelectGroup>
                                    <SelectLabel>{group.label}</SelectLabel>
                                    {group.values.map((value) => (
                                        <SelectItem key={value.value} value={value.value}>
                                            <span title={value.description}>{value.name}</span>
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            ) : (
                                group.values.map((value) => (
                                    <SelectItem key={value.value} value={value.value}>
                                        <span title={value.description}>{value.name}</span>
                                    </SelectItem>
                                ))
                            )}
                        </Fragment>
                    ))}
                </SelectContent>
            </Select>
            {failure.length > 0 && (
                <p className="col-span-2 text-[11px] leading-[17px] text-destructive" id={errorId} role="alert">
                    {failure}
                </p>
            )}
        </div>
    );
}

function BooleanConfigControl({
    disabled: controlDisabled,
    onConfigure,
    option,
    pending,
    setPending,
}: ConfigControlProps) {
    const descriptionId = useId();
    const errorId = useId();
    const [failure, setFailure] = useState("");
    const disabled = controlDisabled || pending;
    const describedBy = [option.description.length > 0 ? descriptionId : "", failure.length > 0 ? errorId : ""]
        .filter((id) => id.length > 0)
        .join(" ");

    return (
        <div className="grid gap-1">
            <button
                aria-checked={option.booleanValue}
                aria-describedby={describedBy.length > 0 ? describedBy : undefined}
                className="flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-black/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-55"
                disabled={disabled}
                onClick={() => {
                    setFailure("");
                    setPending(option.id, true);
                    void onConfigure(option, "", !option.booleanValue)
                        .then(setFailure)
                        .finally(() => {
                            setPending(option.id, false);
                        });
                }}
                role="switch"
                title={option.description.length > 0 ? option.description : option.name}
                type="button"
            >
                <span className="min-w-0 flex-1">
                    <strong className="block text-xs font-semibold text-foreground">{option.name}</strong>
                    {option.description.length > 0 && (
                        <span
                            className="mt-0.5 block text-[11px] leading-[17px] text-muted-foreground"
                            id={descriptionId}
                        >
                            {option.description}
                        </span>
                    )}
                </span>
                <span
                    aria-hidden="true"
                    className={cn(
                        "flex h-6 w-10 shrink-0 items-center rounded-full bg-black/10 p-0.5 transition-colors duration-150 motion-reduce:transition-none",
                        option.booleanValue && "bg-primary/20",
                    )}
                >
                    <span
                        className={cn(
                            "flex size-5 items-center justify-center rounded-full bg-white text-primary shadow-sm transition-transform duration-150 motion-reduce:transition-none",
                            option.booleanValue && "translate-x-4",
                        )}
                    >
                        {pending ? (
                            <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                        ) : (
                            option.booleanValue && <Check className="size-3" />
                        )}
                    </span>
                </span>
            </button>
            {failure.length > 0 && (
                <p className="px-3 pb-2.5 text-[11px] leading-[17px] text-destructive" id={errorId} role="alert">
                    {failure}
                </p>
            )}
        </div>
    );
}

interface SessionConfigControlsViewProps {
    readonly agentLabel: string;
    readonly directoryLabel: string;
    readonly failure: string;
    readonly isPreparing: boolean;
    readonly isReady: boolean;
    readonly isRunning: boolean;
    readonly onConfigure: (option: SessionConfigOption, value: string, booleanValue: boolean) => Promise<string>;
    readonly onRetry: () => void;
    readonly options: readonly SessionConfigOption[];
    readonly statusLabel: string;
}

export function SessionConfigControlsView({
    agentLabel,
    directoryLabel,
    failure,
    isPreparing,
    isReady,
    isRunning,
    onConfigure,
    onRetry,
    options,
    statusLabel,
}: SessionConfigControlsViewProps) {
    const [open, setOpen] = useState(false);
    const [panelLayout, setPanelLayout] = useState<SessionConfigPanelLayout>(PENDING_PANEL_LAYOUT);
    const [pendingIds, setPendingIds] = useState<readonly string[]>([]);
    const panelRef = useRef<HTMLElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelId = useId();
    const summary = isReady
        ? summarizeSessionConfig(options)
        : {
              accessibleLabel: statusLabel,
              compactLabel: statusLabel,
          };

    const close = useCallback((): void => {
        setOpen(false);
        setPanelLayout(PENDING_PANEL_LAYOUT);
        triggerRef.current?.focus();
    }, []);

    useLayoutEffect(() => {
        if (!open) {
            return;
        }
        const trigger = triggerRef.current;
        if (trigger === null) {
            return;
        }
        const updateLayout = (): void => {
            if (
                sessionConfigPanelMode({
                    viewportHeight: window.innerHeight,
                    viewportWidth: window.innerWidth,
                }) === "sheet"
            ) {
                setPanelLayout({ kind: "sheet" });
                return;
            }
            const anchor = trigger.getBoundingClientRect();
            setPanelLayout(
                placeSessionConfigPanel({
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
    }, [open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const focusFrame = window.requestAnimationFrame(() => {
            panelRef.current?.focus({ preventScroll: true });
        });
        const controller = new AbortController();
        window.addEventListener(
            "keydown",
            (event) => {
                const activeElement = document.activeElement;
                const action = sessionConfigPanelKeyAction({
                    key: event.key,
                    selectMenuOpen: document.querySelector("[data-slot='select-content'][data-state='open']") !== null,
                });
                if (action === "keep-open") {
                    return;
                }
                if (action === "close") {
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
            { capture: true, signal: controller.signal },
        );
        return () => {
            window.cancelAnimationFrame(focusFrame);
            controller.abort();
        };
    }, [close, open]);

    const setPending = (id: string, pending: boolean): void => {
        setPendingIds((current) =>
            pending ? (current.includes(id) ? current : [...current, id]) : current.filter((entry) => entry !== id),
        );
    };

    return (
        <div className="relative w-fit min-w-0 max-w-[176px] shrink max-[360px]:w-11 max-[360px]:max-w-11 max-[360px]:shrink-0 lg:max-w-none lg:shrink-0">
            <Button
                aria-controls={panelId}
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-label={summary.accessibleLabel}
                className={cn(
                    "group h-11 w-auto max-w-full min-w-0 gap-0 rounded-full bg-transparent p-1 text-xs text-copy-secondary hover:bg-transparent lg:h-9 lg:max-w-[240px] lg:p-0",
                    failure.length > 0 && "text-destructive",
                )}
                onClick={() => {
                    if (open) {
                        close();
                    } else {
                        setPanelLayout(PENDING_PANEL_LAYOUT);
                        setOpen(true);
                    }
                }}
                ref={triggerRef}
                title={summary.accessibleLabel}
                variant="ghost"
            >
                <span className="flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-full border-[0.5px] border-black/8 bg-black/[0.025] px-2.5 transition-colors duration-150 group-hover:border-black/12 group-hover:bg-black/[0.05] motion-reduce:transition-none max-[360px]:w-9 max-[360px]:justify-center max-[360px]:gap-0 max-[360px]:border-transparent max-[360px]:bg-transparent max-[360px]:px-0 max-[360px]:group-hover:bg-black/[0.04]">
                    {isPreparing ? (
                        <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
                    ) : (
                        <Settings2 className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 truncate max-[360px]:hidden">{summary.compactLabel}</span>
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(
                            "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none max-[360px]:hidden",
                            open && "rotate-180",
                        )}
                    />
                </span>
            </Button>
            {open && (
                <>
                    <button
                        aria-label="Close run settings"
                        className={cn(
                            "fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px]",
                            panelLayout.kind !== "sheet" && "md:bg-transparent md:backdrop-blur-none",
                        )}
                        onClick={close}
                        type="button"
                    />
                    <section
                        aria-label="Run settings"
                        aria-modal="true"
                        className={cn(
                            "mobile-safe-sheet fixed inset-x-3 bottom-3 z-40 flex max-h-[min(76vh,620px)] flex-col overflow-hidden rounded-2xl border-[0.5px] border-black/10 bg-white shadow-[0_20px_70px_rgba(0,0,0,0.22)] outline-none md:shadow-[0_16px_44px_rgba(0,0,0,0.15)]",
                            panelLayout.kind !== "sheet" && "md:inset-auto md:max-h-none md:max-w-none",
                            panelLayout.kind === "pending" && "md:invisible",
                        )}
                        data-session-config-panel=""
                        data-placement={panelLayout.kind}
                        id={panelId}
                        ref={panelRef}
                        role="dialog"
                        style={panelStyle(panelLayout)}
                        tabIndex={-1}
                    >
                        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b-[0.5px] border-black/7 px-4">
                            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-success">
                                <Settings2 className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <strong className="block text-sm font-semibold">Run settings</strong>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                    {agentLabel} · {directoryLabel}
                                </span>
                            </span>
                            <Button
                                aria-label="Close run settings"
                                className="size-11 lg:size-9"
                                onClick={close}
                                size="icon"
                                variant="ghost"
                            >
                                <X className="size-4" />
                            </Button>
                        </header>
                        <div className="conversation-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain bg-surface-subtle/70 p-3">
                            {isRunning && (
                                <p className="mb-3 rounded-lg bg-black/[0.045] px-3 py-2 text-[11px] leading-[18px] text-muted-foreground">
                                    Settings are locked while this run is active.
                                </p>
                            )}
                            {failure.length > 0 ? (
                                <div className="rounded-xl border-[0.5px] border-destructive/15 bg-destructive/5 p-4 text-center">
                                    <p className="text-xs leading-5 text-destructive">{failure}</p>
                                    <Button
                                        className="mt-3 min-h-11 lg:min-h-9"
                                        onClick={() => {
                                            onRetry();
                                        }}
                                        size="sm"
                                        variant="outline"
                                    >
                                        <RefreshCw className="size-3.5" />
                                        Retry agent
                                    </Button>
                                </div>
                            ) : isReady ? (
                                options.length === 0 ? (
                                    <p className="px-3 py-8 text-center text-xs leading-5 text-muted-foreground">
                                        This agent uses its default run settings.
                                    </p>
                                ) : (
                                    <div className="grid gap-4">
                                        {groupSessionConfigOptions(options).map((section) => (
                                            <fieldset className="grid gap-2 border-0 p-0" key={section.id}>
                                                <legend className="mb-1 px-1 text-[10px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
                                                    {section.label}
                                                </legend>
                                                <div className="divide-y divide-black/[0.07] overflow-hidden rounded-xl border-[0.5px] border-black/9 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.025)]">
                                                    {section.options.map((option) =>
                                                        option.type === "select" ? (
                                                            <SelectConfigControl
                                                                disabled={isRunning || pendingIds.length > 0}
                                                                key={option.id}
                                                                onConfigure={onConfigure}
                                                                option={option}
                                                                pending={pendingIds.includes(option.id)}
                                                                setPending={setPending}
                                                            />
                                                        ) : (
                                                            <BooleanConfigControl
                                                                disabled={isRunning || pendingIds.length > 0}
                                                                key={option.id}
                                                                onConfigure={onConfigure}
                                                                option={option}
                                                                pending={pendingIds.includes(option.id)}
                                                                setPending={setPending}
                                                            />
                                                        ),
                                                    )}
                                                </div>
                                            </fieldset>
                                        ))}
                                    </div>
                                )
                            ) : (
                                <div
                                    aria-live="polite"
                                    className="flex min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground"
                                >
                                    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                                    {statusLabel}
                                </div>
                            )}
                        </div>
                    </section>
                </>
            )}
        </div>
    );
}

export function SessionConfigControls() {
    const conversation = useChatStore(selectActiveConversation);
    const ready = conversation.session instanceof ReadySessionState;
    return (
        <SessionConfigControlsView
            agentLabel={conversation.agentLabel}
            directoryLabel={conversation.directoryLabel}
            failure={conversation.session instanceof SessionPreparationFailedState ? conversation.session.error : ""}
            isPreparing={conversation.session.isPreparing}
            isReady={ready}
            isRunning={conversation.isRunning}
            onConfigure={async (option, value, booleanValue) => {
                const result = await configureSessionOption(
                    conversation.agentId,
                    conversation.sessionId,
                    conversation.directoryId,
                    conversation.additionalDirectories.map((directory) => directory.directoryId),
                    option,
                    value,
                    booleanValue,
                );
                return result.kind === "failed" ? `${result.code}: ${result.message}` : "";
            }}
            onRetry={() => {
                void prepareActiveSession(conversation.sessionId);
            }}
            options={ready ? conversation.session.configOptions : []}
            statusLabel={conversation.session.label}
        />
    );
}
