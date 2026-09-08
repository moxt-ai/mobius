import type { RecordedActivity } from "@/domain/channel";

export interface ActivityDisclosurePresentation {
    readonly defaultOpen: boolean;
    readonly label: string;
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
