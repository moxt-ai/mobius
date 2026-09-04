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
import { type ReactNode, useEffect, useState } from "react";

import { AgentRichContent } from "@/components/agent-rich-content";
import type { RecordedActivity } from "@/domain/channel";
import { cn } from "@/lib/utils";
import { describeAgentActivities } from "@/services/activity-presentation";

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
  if (
    activity.toolKind === "edit" ||
    activity.toolKind === "delete" ||
    activity.toolKind === "move"
  ) {
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
    return (
      <LoaderCircle className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
    );
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

function ActivityText({ children }: { readonly children: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-black/[0.025] px-3 py-2.5 font-mono text-[11px] leading-[18px] whitespace-pre-wrap text-copy-secondary">
      {children}
    </pre>
  );
}

function ToolDetails({ activity }: { readonly activity: RecordedActivity }) {
  return (
    <div className="mt-1 ml-[7px] grid gap-2 border-l-[0.5px] border-black/10 pt-1 pb-2 pl-[22px]">
      {activity.locations.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-copy-tertiary uppercase">
            Locations
          </p>
          <ul className="m-0 grid list-none gap-0.5 p-0 font-mono text-[11px] leading-[18px] text-copy-secondary">
            {activity.locations.map((location) => (
              <li className="break-all" key={location}>
                {location}
              </li>
            ))}
          </ul>
        </div>
      )}
      {activity.input.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-copy-tertiary uppercase">
            Input
          </p>
          <ActivityText>{activity.input}</ActivityText>
        </div>
      )}
      {activity.output.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-copy-tertiary uppercase">
            Output
          </p>
          <ActivityText>{activity.output}</ActivityText>
        </div>
      )}
      <AgentRichContent contents={activity.content} />
    </div>
  );
}

function NarrativeDetails({
  activity,
}: {
  readonly activity: RecordedActivity;
}) {
  if (activity.output.length === 0 && activity.content.length === 0) {
    return null;
  }
  return (
    <div className="mt-1 ml-[7px] border-l-[0.5px] border-black/10 pt-1 pb-2 pl-[22px]">
      {activity.output.length > 0 && (
        <ActivityText>{activity.output}</ActivityText>
      )}
      <AgentRichContent contents={activity.content} />
    </div>
  );
}

function ActivityLine({
  activity,
  streaming,
}: {
  readonly activity: RecordedActivity;
  readonly streaming: boolean;
}) {
  const [open, setOpen] = useState(activity.status === "failed");
  useEffect(() => {
    if (activity.status === "failed") {
      setOpen(true);
    }
  }, [activity.status]);
  const hasDetails =
    activity.input.length > 0 ||
    activity.output.length > 0 ||
    activity.locations.length > 0 ||
    activity.content.length > 0;
  const summary = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span
        className={cn(
          "shrink-0 text-copy-tertiary",
          activity.status === "failed" && "text-destructive",
        )}
      >
        {activityIcon(activity)}
      </span>
      <span className="min-w-0 flex-1 truncate text-copy-secondary">
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
        <span className="sr-only sm:not-sr-only">
          {statusLabel(activity.status, streaming)}
        </span>
      </span>
    </span>
  );

  if (!hasDetails) {
    return (
      <div className="flex min-h-7 items-center text-[13px] leading-[22px]">
        {summary}
      </div>
    );
  }

  return (
    <details
      className="group/activity"
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
        <ToolDetails activity={activity} />
      ) : (
        <NarrativeDetails activity={activity} />
      )}
    </details>
  );
}

export function AgentActivityList({
  activities,
  streaming,
}: {
  readonly activities: readonly RecordedActivity[];
  readonly streaming: boolean;
}) {
  const initialPresentation = describeAgentActivities(activities, streaming);
  const [manuallyOpen, setManuallyOpen] = useState(
    () => !streaming && initialPresentation.defaultOpen,
  );
  const working =
    streaming &&
    activities.some(
      (activity) =>
        activity.status === "pending" || activity.status === "running",
    );
  const presentation = describeAgentActivities(activities, streaming);
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
    <details
      className="group/work mb-3"
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
      <div className="mt-1.5 grid gap-1">
        {activities.map((activity) => (
          <ActivityLine
            activity={activity}
            key={activity.activityId}
            streaming={streaming}
          />
        ))}
      </div>
    </details>
  );
}
