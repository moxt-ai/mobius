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
import { type ReactNode, useState } from "react";

import type { RecordedActivity } from "@/domain/channel";
import { cn } from "@/lib/utils";

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
    return <CircleCheck className="size-3 shrink-0" />;
  }
  if (status === "failed") {
    return <CircleX className="size-3 shrink-0" />;
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
    <pre className="max-h-72 overflow-auto rounded-lg border-[0.5px] border-black/5 bg-black/[0.025] px-3 py-2.5 font-mono text-[11px] leading-[18px] whitespace-pre-wrap text-[#5f6672]">
      {children}
    </pre>
  );
}

function ToolDetails({ activity }: { readonly activity: RecordedActivity }) {
  return (
    <div className="mt-1.5 ml-[22px] grid gap-2 pb-1.5">
      {activity.locations.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-[#8a919d] uppercase">
            Locations
          </p>
          <ul className="m-0 grid list-none gap-0.5 p-0 font-mono text-[11px] leading-[18px] text-[#5f6672]">
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
          <p className="mb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-[#8a919d] uppercase">
            Input
          </p>
          <ActivityText>{activity.input}</ActivityText>
        </div>
      )}
      {activity.output.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-[#8a919d] uppercase">
            Output
          </p>
          <ActivityText>{activity.output}</ActivityText>
        </div>
      )}
    </div>
  );
}

function NarrativeDetails({
  activity,
}: {
  readonly activity: RecordedActivity;
}) {
  if (activity.output.length === 0) {
    return null;
  }
  return (
    <div className="mt-1.5 ml-[22px] pb-1.5">
      <ActivityText>{activity.output}</ActivityText>
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
  const hasDetails =
    activity.input.length > 0 ||
    activity.output.length > 0 ||
    activity.locations.length > 0;
  const summary = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span
        className={cn(
          "shrink-0 text-[#7d8590]",
          activity.status === "failed" && "text-[#b4232a]",
        )}
      >
        {activityIcon(activity)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[#555c68]">
        {activity.title}
      </span>
      {activity.name.length > 0 && (
        <code className="hidden max-w-32 truncate rounded bg-black/[0.035] px-1.5 py-0.5 font-mono text-[10px] text-[#7d8590] sm:block">
          {activity.name}
        </code>
      )}
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 text-[10px] text-[#8a919d]",
          activity.status === "running" && streaming && "text-[#9a6700]",
          activity.status === "completed" && "text-[#279a60]",
          activity.status === "failed" && "text-[#b4232a]",
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
      <div className="flex min-h-7 items-center px-1 text-xs">{summary}</div>
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
      <summary className="flex min-h-7 max-w-full cursor-pointer list-none items-center gap-1 rounded px-1 text-xs outline-none hover:bg-black/[0.025] focus-visible:ring-2 focus-visible:ring-[#2fb872]/35">
        {summary}
        <ChevronRight className="size-3 shrink-0 text-[#9aa0aa] transition-transform duration-150 group-open/activity:rotate-90" />
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
  const [open, setOpen] = useState(streaming);
  if (activities.length === 0) {
    return null;
  }
  const working =
    streaming &&
    activities.some(
      (activity) =>
        activity.status === "pending" || activity.status === "running",
    );

  return (
    <details
      className="group/work mt-3 rounded-lg border-[0.5px] border-black/7 bg-white/55 px-2.5 py-1.5"
      data-testid="agent-work-details"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      open={open}
    >
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded px-1 text-[11px] font-medium text-[#676e79] outline-none hover:text-[#454959] focus-visible:ring-2 focus-visible:ring-[#2fb872]/35">
        <ChevronRight className="size-3.5 shrink-0 transition-transform duration-150 group-open/work:rotate-90" />
        <span>Work details</span>
        <span className="font-normal text-[#949aa4]">
          {activities.length.toString()}
        </span>
        {working && (
          <LoaderCircle className="ml-auto size-3.5 animate-spin text-[#9a6700] motion-reduce:animate-none" />
        )}
      </summary>
      <div className="mt-1 border-t-[0.5px] border-black/6 pt-1">
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
