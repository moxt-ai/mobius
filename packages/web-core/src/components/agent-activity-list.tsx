import {
    Brain,
    ChevronRight,
    CircleCheck,
    CircleX,
    Clock3,
    FileDiff,
    FileText,
    Globe,
    ListChecks,
    LoaderCircle,
    MessageCircleMore,
    Search,
    Terminal,
    Wrench,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { AgentMarkdown } from "@/components/agent-markdown";
import { AgentRichContent } from "@/components/agent-rich-content";
import type { RecordedActivity } from "@/domain/channel";
import { cn } from "@/lib/utils";
import { describeAgentActivities } from "@/services/activity-presentation";
import { type ActivityDetailResult, readToolCallDetail } from "@/services/pairing-api";

type ActivityDetailLoadState =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly detail: ActivityDetailResult; readonly kind: "loaded" }
    | { readonly kind: "failed"; readonly message: string };

function activityIcon(activity: RecordedActivity): ReactNode {
    if (activity.activityType === "reasoning") {
        return <Brain className="size-3.5" />;
    }
    if (activity.activityType === "progress") {
        return <MessageCircleMore className="size-3.5" />;
    }
    if (activity.activityType === "plan") {
        return <ListChecks className="size-3.5" />;
    }
    if (activity.toolKind === "execute") {
        return <Terminal className="size-3.5" />;
    }
    if (activity.toolKind === "edit" || activity.toolKind === "delete" || activity.toolKind === "move") {
        return <FileDiff className="size-3.5" />;
    }
    if (activity.toolKind === "read") {
        return <FileText className="size-3.5" />;
    }
    if (activity.toolKind === "search") {
        return <Search className="size-3.5" />;
    }
    if (activity.toolKind === "fetch") {
        return <Globe className="size-3.5" />;
    }
    return <Wrench className="size-3.5" />;
}

function statusIcon(status: string, active: boolean): ReactNode {
    if (status === "running" && active) {
        return <LoaderCircle className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />;
    }
    if (status === "completed") {
        return <CircleCheck className="size-3 shrink-0 text-success" />;
    }
    if (status === "failed") {
        return <CircleX className="size-3 shrink-0 text-destructive" />;
    }
    return <Clock3 className="size-3 shrink-0" />;
}

function statusLabel(status: string, active: boolean): string {
    if (!active && (status === "pending" || status === "running")) {
        return "Stopped";
    }
    if (status === "running") {
        return "Running";
    }
    if (status === "completed") {
        return "Completed";
    }
    if (status === "failed") {
        return "Failed";
    }
    return "Pending";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function presentActivityText(value: string): string {
    let decoded: unknown;
    try {
        decoded = JSON.parse(value);
    } catch {
        return value;
    }
    if (!isRecord(decoded)) {
        return value;
    }
    const keys = Object.keys(decoded);
    if (keys.some((key) => key !== "exit_code" && key !== "formatted_output")) {
        return value;
    }
    const { exit_code: exitCode, formatted_output: formattedOutput } = decoded;
    if (typeof formattedOutput !== "string" || (exitCode !== undefined && typeof exitCode !== "number")) {
        return value;
    }
    const content = formattedOutput.trimEnd();
    return typeof exitCode === "number" && exitCode !== 0 ? `${content}\n\nExit code: ${exitCode.toString()}` : content;
}

function ActivityText({
    children,
    unwrapToolOutput = false,
}: {
    readonly children: string;
    readonly unwrapToolOutput?: boolean;
}) {
    return (
        <pre className="max-h-80 min-w-0 max-w-full overflow-auto rounded-lg border border-black/[0.07] bg-black/[0.025] px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-copy-secondary [overflow-wrap:anywhere]">
            {unwrapToolOutput ? presentActivityText(children) : children}
        </pre>
    );
}

function ToolDetails({
    activity,
    detail,
}: {
    readonly activity: RecordedActivity;
    readonly detail: ActivityDetailResult | null;
}) {
    const available = detail?.kind === "available" ? detail : null;
    const input = available?.input ?? activity.input;
    const output = available?.output ?? activity.output;
    const content = available?.content ?? activity.content;
    return (
        <div className="mt-1 ml-[7px] grid min-w-0 max-w-full gap-2 border-l-[0.5px] border-black/10 pt-1 pb-2 pl-[22px]">
            {activity.locations.length > 0 && (
                <div className="min-w-0 max-w-full">
                    <p className="mb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-copy-tertiary uppercase">
                        Locations
                    </p>
                    <ul className="m-0 grid list-none gap-0.5 p-0 font-mono text-xs leading-5 text-copy-secondary">
                        {activity.locations.map((location) => (
                            <li className="[overflow-wrap:anywhere]" key={location}>
                                {location}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {input.length > 0 && (
                <div className="min-w-0 max-w-full">
                    <p className="mb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-copy-tertiary uppercase">
                        Input
                    </p>
                    <ActivityText>{input}</ActivityText>
                </div>
            )}
            {output.length > 0 && (
                <div className="min-w-0 max-w-full">
                    <p className="mb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-copy-tertiary uppercase">
                        Output
                    </p>
                    <ActivityText unwrapToolOutput>{output}</ActivityText>
                </div>
            )}
            <AgentRichContent contents={content} />
        </div>
    );
}

function NarrativeDetails({
    activity,
    detail,
    streaming,
}: {
    readonly activity: RecordedActivity;
    readonly detail: ActivityDetailResult | null;
    readonly streaming: boolean;
}) {
    const available = detail?.kind === "available" ? detail : null;
    const output = available?.output ?? activity.output;
    const content = available?.content ?? activity.content;
    if (output.length === 0 && content.length === 0) {
        return null;
    }
    return (
        <div className="agent-step-narrative mt-1 ml-[7px] min-w-0 max-w-full border-l-[0.5px] border-black/10 pt-1 pb-2 pl-[22px]">
            {output.length > 0 && <AgentMarkdown markdown={output} streaming={streaming} />}
            <AgentRichContent contents={content} />
        </div>
    );
}

function DetailAvailability({
    load,
    onRetry,
}: {
    readonly load: ActivityDetailLoadState;
    readonly onRetry: () => void;
}) {
    if (load.kind === "idle") {
        return null;
    }
    if (load.kind === "loading") {
        return (
            <p
                aria-live="polite"
                className="mt-2 ml-[29px] inline-flex items-center gap-1.5 text-[11px] text-copy-tertiary"
                role="status"
            >
                <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                Loading full details…
            </p>
        );
    }
    if (load.kind === "failed") {
        return (
            <div className="mt-2 ml-[29px] flex items-center gap-2 text-[11px] text-destructive" role="alert">
                <span>{load.message}</span>
                <button
                    className="min-h-11 rounded px-2 font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-8"
                    onClick={onRetry}
                    type="button"
                >
                    Retry
                </button>
            </div>
        );
    }
    const detail = load.detail;
    if (detail.kind === "available") {
        return null;
    }
    const message =
        detail.kind === "truncated"
            ? `Full details were truncated at capture time (${detail.capturedBytes.toLocaleString()} of ${detail.originalBytes.toLocaleString()} bytes retained).`
            : detail.kind === "unrecorded"
              ? "Full details were not recorded for this activity."
              : `Full details were deleted on ${detail.deletedAt.toLocaleString()}.`;
    return (
        <p className="mt-2 ml-[29px] text-[11px] leading-[18px] text-copy-tertiary" role="status">
            {message}
        </p>
    );
}

function ActivityLine({
    activity,
    channelId,
    sessionId,
    streaming,
}: {
    readonly activity: RecordedActivity;
    readonly channelId: string;
    readonly sessionId: string;
    readonly streaming: boolean;
}) {
    const [open, setOpen] = useState(activity.status === "failed");
    const [detailLoad, setDetailLoad] = useState<ActivityDetailLoadState>({
        kind: "idle",
    });
    const detailController = useRef<AbortController | null>(null);
    const detailLoadKind = useRef<ActivityDetailLoadState["kind"]>("idle");
    const loadDetails = useCallback((): void => {
        if (
            activity.detailAvailability === "inline" ||
            detailLoadKind.current === "loading" ||
            detailLoadKind.current === "loaded"
        ) {
            return;
        }
        detailController.current?.abort();
        const controller = new AbortController();
        detailController.current = controller;
        detailLoadKind.current = "loading";
        setDetailLoad({ kind: "loading" });
        void readToolCallDetail(channelId, sessionId, activity.attemptId, activity.activityId, controller.signal).then(
            (detail) => {
                if (controller.signal.aborted) {
                    return;
                }
                detailLoadKind.current = "loaded";
                setDetailLoad({ detail, kind: "loaded" });
            },
            (error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }
                detailLoadKind.current = "failed";
                setDetailLoad({
                    kind: "failed",
                    message: error instanceof Error ? error.message : "Full details could not be loaded.",
                });
            },
        );
    }, [activity.activityId, activity.attemptId, activity.detailAvailability, channelId, sessionId]);
    useEffect(() => {
        return () => detailController.current?.abort();
    }, []);
    useEffect(() => {
        if (activity.status === "failed") {
            setOpen(true);
        }
    }, [activity.status]);
    useEffect(() => {
        if (open) {
            loadDetails();
        }
    }, [loadDetails, open]);
    const hasDetails =
        activity.input.length > 0 ||
        activity.output.length > 0 ||
        activity.locations.length > 0 ||
        activity.content.length > 0 ||
        activity.detailAvailability !== "inline";
    const loadedDetail = detailLoad.kind === "loaded" ? detailLoad.detail : null;
    const summary = (
        <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className={cn("shrink-0 text-copy-tertiary", activity.status === "failed" && "text-destructive")}>
                {activityIcon(activity)}
            </span>
            <span className="min-w-0 flex-1 truncate text-copy-secondary" title={activity.title}>
                {activity.title}
            </span>
            {activity.name.length > 0 && (
                <code className="hidden max-w-32 truncate rounded bg-black/[0.035] px-1.5 py-0.5 font-mono text-[10px] text-copy-tertiary sm:block">
                    {activity.name}
                </code>
            )}
            <span
                className={cn(
                    "inline-flex shrink-0 items-center gap-1 text-[10px] text-copy-tertiary",
                    activity.status === "running" && streaming && "text-warning",
                    activity.status === "completed" && "text-success",
                    activity.status === "failed" && "text-destructive",
                )}
            >
                {statusIcon(activity.status, streaming)}
                <span className={cn("sr-only", activity.status !== "completed" && "sm:not-sr-only")}>
                    {statusLabel(activity.status, streaming)}
                </span>
            </span>
        </span>
    );

    if (!hasDetails) {
        return <div className="flex min-h-7 items-center text-[13px] leading-[22px]">{summary}</div>;
    }

    return (
        <details
            className="group/activity min-w-0 max-w-full"
            data-activity-type={activity.activityType}
            data-status={activity.status}
            data-testid="agent-activity"
            onToggle={(event) => {
                setOpen(event.currentTarget.open);
            }}
            open={open}
        >
            <summary className="flex min-h-11 max-w-full cursor-pointer list-none items-center gap-1 rounded text-[13px] leading-[22px] outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-7">
                {summary}
                <ChevronRight className="size-3 shrink-0 text-copy-tertiary transition-transform duration-150 motion-reduce:transition-none group-open/activity:rotate-90" />
            </summary>
            {activity.activityType === "tool" ? (
                <ToolDetails activity={activity} detail={loadedDetail} />
            ) : (
                <NarrativeDetails
                    activity={activity}
                    detail={loadedDetail}
                    streaming={streaming && (activity.status === "pending" || activity.status === "running")}
                />
            )}
            <DetailAvailability load={detailLoad} onRetry={loadDetails} />
        </details>
    );
}

function ProgressUpdates({
    activities,
    streaming,
}: {
    readonly activities: readonly RecordedActivity[];
    readonly streaming: boolean;
}) {
    if (activities.length === 0) {
        return null;
    }
    return (
        <div className="mb-4 grid gap-3">
            {activities.map((activity) => {
                const active = streaming && (activity.status === "pending" || activity.status === "running");
                return (
                    <section
                        aria-label="Agent progress update"
                        aria-live={active ? "polite" : undefined}
                        className={cn("agent-progress min-w-0", active && "agent-stream is-streaming")}
                        key={activity.activityId}
                    >
                        {activity.output.length > 0 && <AgentMarkdown markdown={activity.output} streaming={active} />}
                        <AgentRichContent contents={activity.content} />
                    </section>
                );
            })}
        </div>
    );
}

export function AgentActivityList({
    activities,
    channelId,
    sessionId,
    streaming,
}: {
    readonly activities: readonly RecordedActivity[];
    readonly channelId: string;
    readonly sessionId: string;
    readonly streaming: boolean;
}) {
    const progressActivities = activities.filter((activity) => activity.activityType === "progress");
    const workActivities = activities.filter((activity) => activity.activityType !== "progress");
    const initialPresentation = describeAgentActivities(workActivities, streaming);
    const [manuallyOpen, setManuallyOpen] = useState(() => !streaming && initialPresentation.defaultOpen);
    const working =
        streaming && workActivities.some((activity) => activity.status === "pending" || activity.status === "running");
    const presentation = describeAgentActivities(workActivities, streaming);
    useEffect(() => {
        if (!streaming && presentation.defaultOpen) {
            setManuallyOpen(true);
        }
    }, [presentation.defaultOpen, streaming]);
    if (activities.length === 0) {
        return null;
    }
    const open = streaming || manuallyOpen;
    const disclosureLabel = presentation.label;

    return (
        <>
            <ProgressUpdates activities={progressActivities} streaming={streaming} />
            {workActivities.length > 0 && (
                <details
                    className="group/work mb-3 min-w-0 max-w-full"
                    data-testid="agent-process-disclosure"
                    onToggle={(event) => {
                        if (!streaming) {
                            setManuallyOpen(event.currentTarget.open);
                        }
                    }}
                    open={open}
                >
                    <summary
                        aria-label={`${open ? "Hide" : "Show"} ${disclosureLabel}`}
                        className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-xs leading-5 text-copy-tertiary outline-none select-none hover:bg-black/[0.035] hover:text-copy-secondary focus-visible:ring-2 focus-visible:ring-ring/70 md:min-h-8"
                    >
                        <ChevronRight className="size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none group-open/work:rotate-90" />
                        <span>{disclosureLabel}</span>
                        {working && (
                            <LoaderCircle className="ml-1 size-3.5 animate-spin text-warning motion-reduce:animate-none" />
                        )}
                    </summary>
                    <div className="mt-1.5 grid min-w-0 max-w-full gap-1">
                        {workActivities.map((activity) => (
                            <ActivityLine
                                activity={activity}
                                channelId={channelId}
                                key={`${sessionId}:${activity.activityId}`}
                                sessionId={sessionId}
                                streaming={streaming}
                            />
                        ))}
                    </div>
                </details>
            )}
        </>
    );
}
