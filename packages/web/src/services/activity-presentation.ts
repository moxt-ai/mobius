import type { RecordedActivity, TurnTiming } from "@/domain/channel";

export interface SettledTurnProcessPresentation {
    readonly defaultOpen: boolean;
    readonly label: string;
    readonly toggleLabel: string;
}

const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** Formats elapsed Turn time the way the transcript reads it back: "11m 22s", "45s", or "1h 4m". */
function formatTurnDuration(elapsedMilliseconds: number): string {
    const totalSeconds = Math.max(0, Math.round(elapsedMilliseconds / MILLISECONDS_PER_SECOND));
    const seconds = totalSeconds % SECONDS_PER_MINUTE;
    const totalMinutes = (totalSeconds - seconds) / SECONDS_PER_MINUTE;
    const minutes = totalMinutes % MINUTES_PER_HOUR;
    const hours = (totalMinutes - minutes) / MINUTES_PER_HOUR;
    if (hours > 0) {
        return `${hours.toString()}h ${minutes.toString()}m`;
    }
    if (totalMinutes > 0) {
        return `${totalMinutes.toString()}m ${seconds.toString()}s`;
    }
    return `${seconds.toString()}s`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeAgentActivity(activity: RecordedActivity): string {
    if (activity.activityType !== "tool" || activity.toolKind !== "execute") {
        return activity.title;
    }
    let input: unknown;
    try {
        input = JSON.parse(activity.input);
    } catch {
        return activity.title;
    }
    if (!isRecord(input)) {
        return activity.title;
    }
    const { description } = input;
    if (typeof description !== "string") {
        return activity.title;
    }
    const normalized = description.trim();
    return normalized.length > 0 ? normalized.slice(0, 500) : activity.title;
}

/**
 * Describes the collapsed summary a finished Turn shows in place of its intermediate work. Measured
 * Turns read as "Worked for 11m 22s"; Turns whose timing was never recorded fall back to step counts.
 */
export function describeSettledTurnProcess(
    activities: readonly RecordedActivity[],
    timing: TurnTiming,
): SettledTurnProcessPresentation {
    const stepLabel = `${activities.length.toString()} ${activities.length === 1 ? "step" : "steps"}`;
    const base =
        timing.kind === "measured" ? `Worked for ${formatTurnDuration(timing.elapsedMilliseconds)}` : stepLabel;
    const failed = activities.some((activity) => activity.status === "failed");
    return {
        defaultOpen: failed,
        label: failed ? `${base} · needs attention` : base,
        toggleLabel: "work for this turn",
    };
}
