import type { RecordedActivity } from "@/domain/channel";

export interface ActivityDisclosurePresentation {
    readonly defaultOpen: boolean;
    readonly label: string;
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

export function describeAgentActivities(
    activities: readonly RecordedActivity[],
    streaming: boolean,
): ActivityDisclosurePresentation {
    const stepLabel = `${activities.length.toString()} ${activities.length === 1 ? "step" : "steps"}`;
    const working =
        streaming && activities.some((activity) => activity.status === "pending" || activity.status === "running");
    if (working) {
        return { defaultOpen: true, label: `Working · ${stepLabel}` };
    }
    const failed = activities.some((activity) => activity.status === "failed");
    if (failed) {
        return { defaultOpen: true, label: `${stepLabel} · needs attention` };
    }
    return { defaultOpen: streaming, label: stepLabel };
}
