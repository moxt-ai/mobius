import type { Plan, PlanEntry, PlanRemoved, PlanUpdate, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AgentDisplayContent } from "@moxt-ai/mobius-protocol";

import {
    ACTIVITY_DETAIL_LIMIT,
    type CapturedActivityDetail,
    captureActivityDetail,
    encodedByteLength,
    formatPlanEntries,
    formatUnknown,
    formatUnknownDetail,
    normalizeLocations,
    normalizeTitle,
    normalizeToolContent,
    normalizeToolStatus,
    planStatus,
    readContentOutput,
    readContentOutputDetail,
    recordedDetail,
    summarizeDisplayContent,
    toolContent,
    truncate,
} from "./activity-content.ts";
/** An incremental append to a streamed narration activity. */
export class AcpActivityNarration {
    readonly activityId: string;
    readonly activityType: string;
    readonly sequence: number;
    readonly text: string;

    constructor(activityId: string, activityType: string, sequence: number, text: string) {
        this.activityId = activityId;
        this.activityType = activityType;
        this.sequence = sequence;
        this.text = text;
    }
}

interface AcpNarrationState {
    readonly activityId: string;
    readonly activityType: string;
    readonly output: string;
    readonly originalBytes: number;
    readonly sequence: number;
    readonly truncated: boolean;
}

export class AcpActivity {
    readonly activityId: string;
    readonly activityType: string;
    readonly input: string;
    readonly locations: readonly string[];
    readonly name: string;
    readonly output: string;
    readonly sequence: number;
    readonly status: string;
    readonly title: string;
    readonly toolKind: string;
    readonly content: readonly AgentDisplayContent[];
    readonly detail: CapturedActivityDetail;

    constructor(
        activityId: string,
        activityType: string,
        input: string,
        locations: readonly string[],
        name: string,
        output: string,
        sequence: number,
        status: string,
        title: string,
        toolKind: string,
        content: readonly AgentDisplayContent[] = [],
        detail: CapturedActivityDetail = captureActivityDetail(content, input, output),
    ) {
        this.activityId = activityId;
        this.activityType = activityType;
        this.input = input;
        this.locations = locations;
        this.name = name;
        this.output = output;
        this.sequence = sequence;
        this.status = status;
        this.title = title;
        this.toolKind = toolKind;
        this.content = content;
        this.detail = detail;
    }

    readonly complete = (): AcpActivity =>
        (this.activityType === "progress" || this.activityType === "reasoning") &&
        (this.status === "pending" || this.status === "running")
            ? new AcpActivity(
                  this.activityId,
                  this.activityType,
                  this.input,
                  this.locations,
                  this.name,
                  this.output,
                  this.sequence,
                  "completed",
                  this.title,
                  this.toolKind,
                  this.content,
                  this.detail,
              )
            : this;
}

class ActivityIdentity {
    readonly id: string;
    readonly sequence: number;

    constructor(id: string, sequence: number) {
        this.id = id;
        this.sequence = sequence;
    }
}

export class AcpActivityTracker {
    readonly #activities = new Map<string, AcpActivity>();
    readonly #identities = new Map<string, ActivityIdentity>();
    readonly #narrations = new Map<string, AcpNarrationState>();
    readonly #noticeRevisions = new Map<string, number>();
    readonly #onActivity: (activity: AcpActivity) => Promise<void>;
    readonly #onNarration: (narration: AcpActivityNarration) => Promise<void>;
    readonly #prepareContent: (content: AgentDisplayContent) => Promise<AgentDisplayContent>;
    #activeNarrativeKey = "";
    #nextSequence = 0;

    constructor(
        onActivity: (activity: AcpActivity) => Promise<void>,
        onNarration: (narration: AcpActivityNarration) => Promise<void>,
        prepareContent: (content: AgentDisplayContent) => Promise<AgentDisplayContent> = (content) =>
            Promise.resolve(content),
    ) {
        this.#onActivity = onActivity;
        this.#onNarration = onNarration;
        this.#prepareContent = prepareContent;
    }

    readonly recordNarrative = async (activityType: string, messageId: string, text: string): Promise<void> => {
        const key = `${activityType}:${messageId}`;
        if (this.#activeNarrativeKey !== key) {
            await this.finishNarrative();
        }
        const identity = this.#identity(key);
        // A narration streams: the activity is announced once, then each chunk travels
        // as its own increment and the accumulated text is materialized exactly once,
        // on completion. Sending the accumulated text per chunk made the queued event
        // stream quadratic in the length of the narration.
        const previous = this.#narrations.get(key);
        const previousOutput = previous?.output ?? "";
        const remaining = Math.max(0, ACTIVITY_DETAIL_LIMIT - previousOutput.length);
        this.#narrations.set(key, {
            activityId: identity.id,
            activityType,
            output: `${previousOutput}${text.slice(0, remaining)}`,
            originalBytes: (previous?.originalBytes ?? 0) + new TextEncoder().encode(text).byteLength,
            sequence: identity.sequence,
            truncated: (previous?.truncated ?? false) || text.length > remaining,
        });
        if (previous === undefined) {
            await this.#record(key, this.#narrativeSnapshot(identity, activityType, "", "running"));
        }
        this.#activeNarrativeKey = key;
        if (text.length > 0) {
            await this.#onNarration(new AcpActivityNarration(identity.id, activityType, identity.sequence, text));
        }
    };

    readonly recordNotice = async (
        id: string,
        revision: number,
        severity: "error" | "warning",
        text: string,
    ): Promise<void> => {
        const key = `notice:${id}`;
        if ((this.#noticeRevisions.get(key) ?? 0) >= revision) {
            return;
        }
        await this.finishNarrative();
        this.#noticeRevisions.set(key, revision);
        const identity = this.#identity(key);
        await this.#record(
            key,
            new AcpActivity(
                identity.id,
                "notice",
                "",
                [],
                "",
                truncate(text, ACTIVITY_DETAIL_LIMIT),
                identity.sequence,
                severity === "error" ? "failed" : "completed",
                severity === "error" ? "Agent error" : "Agent warning",
                "",
            ),
        );
    };

    readonly #narrativeSnapshot = (
        identity: ActivityIdentity,
        activityType: string,
        output: string,
        status: string,
    ): AcpActivity =>
        new AcpActivity(
            identity.id,
            activityType,
            "",
            [],
            "",
            truncate(output, ACTIVITY_DETAIL_LIMIT),
            identity.sequence,
            status,
            activityType === "reasoning" ? "Reasoning" : "Progress update",
            activityType === "reasoning" ? "think" : "",
        );

    readonly recordPlan = async (plan: Plan): Promise<void> => {
        await this.finishNarrative();
        await this.#recordPlanEntries("plan:default", plan.entries);
    };

    readonly recordPlanUpdate = async (update: PlanUpdate): Promise<void> => {
        await this.finishNarrative();
        const plan = update.plan;
        const key = `plan:${plan.planId}`;
        if (plan.type === "items") {
            await this.#recordPlanEntries(key, plan.entries);
            return;
        }
        const identity = this.#identity(key);
        const output = plan.type === "markdown" ? plan.content : `Plan file: ${plan.uri}`;
        await this.#record(
            key,
            new AcpActivity(
                identity.id,
                "plan",
                "",
                [],
                "",
                truncate(output, ACTIVITY_DETAIL_LIMIT),
                identity.sequence,
                "running",
                "Plan",
                "",
            ),
        );
    };

    readonly removePlan = async (update: PlanRemoved): Promise<void> => {
        await this.finishNarrative();
        const key = `plan:${update.planId}`;
        const previous = this.#activities.get(key);
        if (previous !== undefined) {
            await this.#record(
                key,
                new AcpActivity(
                    previous.activityId,
                    previous.activityType,
                    previous.input,
                    previous.locations,
                    previous.name,
                    previous.output,
                    previous.sequence,
                    "completed",
                    previous.title,
                    previous.toolKind,
                    previous.content,
                    previous.detail,
                ),
            );
        }
    };

    readonly recordToolCall = async (update: ToolCall): Promise<void> => {
        await this.finishNarrative();
        const key = `tool:${update.toolCallId}`;
        const identity = this.#identity(key);
        const output =
            update.rawOutput === undefined ? readContentOutput(update.content) : formatUnknown(update.rawOutput);
        const detailInput = update.rawInput === undefined ? "" : formatUnknownDetail(update.rawInput);
        const detailOutput =
            update.rawOutput === undefined
                ? readContentOutputDetail(update.content)
                : formatUnknownDetail(update.rawOutput);
        const detailContent = await normalizeToolContent(
            toolContent(update.content, update.rawOutput),
            this.#prepareContent,
        );
        await this.#record(
            key,
            new AcpActivity(
                identity.id,
                "tool",
                update.rawInput === undefined ? "" : formatUnknown(update.rawInput),
                normalizeLocations(update.locations ?? []),
                truncate(update.name ?? "", 128),
                output,
                identity.sequence,
                normalizeToolStatus(update.status ?? "pending", "pending"),
                normalizeTitle(update.title, "Tool call"),
                update.kind ?? "other",
                detailContent.slice(0, 100).map(summarizeDisplayContent),
                captureActivityDetail(detailContent, detailInput, detailOutput),
            ),
        );
    };

    readonly recordToolCallUpdate = async (update: ToolCallUpdate): Promise<void> => {
        await this.finishNarrative();
        const key = `tool:${update.toolCallId}`;
        const previous = this.#activities.get(key);
        const identity = this.#identity(key);
        const previousDetail = recordedDetail(previous);
        const output =
            update.rawOutput !== undefined
                ? formatUnknown(update.rawOutput)
                : update.content !== undefined && update.content !== null
                  ? readContentOutput(update.content)
                  : (previous?.output ?? "");
        const nextContent = toolContent(update.content, update.rawOutput);
        const content =
            nextContent.length === 0
                ? (previous?.content ?? [])
                : await normalizeToolContent(nextContent, this.#prepareContent);
        const detailInput =
            update.rawInput === undefined
                ? (previousDetail?.input ?? previous?.input ?? "")
                : formatUnknownDetail(update.rawInput);
        const detailOutput =
            update.rawOutput !== undefined
                ? formatUnknownDetail(update.rawOutput)
                : update.content !== undefined && update.content !== null
                  ? readContentOutputDetail(update.content)
                  : (previousDetail?.output ?? previous?.output ?? "");
        const detailContent = nextContent.length === 0 ? (previousDetail?.content ?? previous?.content ?? []) : content;
        await this.#record(
            key,
            new AcpActivity(
                identity.id,
                "tool",
                update.rawInput === undefined ? (previous?.input ?? "") : formatUnknown(update.rawInput),
                update.locations === undefined || update.locations === null
                    ? (previous?.locations ?? [])
                    : normalizeLocations(update.locations),
                update.name === undefined || update.name === null ? (previous?.name ?? "") : truncate(update.name, 128),
                output,
                identity.sequence,
                update.status === undefined || update.status === null
                    ? (previous?.status ?? "pending")
                    : normalizeToolStatus(update.status, previous?.status ?? "pending"),
                update.title === undefined || update.title === null
                    ? (previous?.title ?? "Tool call")
                    : normalizeTitle(update.title, "Tool call"),
                update.kind === undefined || update.kind === null ? (previous?.toolKind ?? "other") : update.kind,
                content.slice(0, 100).map(summarizeDisplayContent),
                captureActivityDetail(detailContent, detailInput, detailOutput),
            ),
        );
    };

    readonly finishNarrative = async (): Promise<void> => {
        const key = this.#activeNarrativeKey;
        if (key.length === 0) {
            return;
        }
        this.#activeNarrativeKey = "";
        await this.#completeNarrative(key);
    };

    readonly finish = async (): Promise<void> => {
        await this.finishNarrative();
        for (const key of this.#narrations.keys()) {
            await this.#completeNarrative(key);
        }
        const entries = [...this.#activities.entries()].sort((left, right) => left[1].sequence - right[1].sequence);
        for (const [key, activity] of entries) {
            const completed = activity.complete();
            if (completed !== activity) {
                await this.#record(key, completed);
            }
        }
    };

    // Materialize a streamed narration as one completed snapshot activity. The
    // incremental events carried the text; this final event gives consumers the
    // whole narration with its terminal status, as a single bounded item.
    readonly #completeNarrative = async (key: string): Promise<void> => {
        const narration = this.#narrations.get(key);
        if (narration === undefined) {
            return;
        }
        this.#narrations.delete(key);
        const previous = this.#activities.get(key);
        const detail: CapturedActivityDetail = narration.truncated
            ? {
                  capturedBytes: encodedByteLength({ content: [], input: "", output: narration.output }),
                  kind: "truncated",
                  originalBytes: narration.originalBytes,
              }
            : captureActivityDetail([], "", narration.output);
        await this.#record(
            key,
            new AcpActivity(
                narration.activityId,
                narration.activityType,
                "",
                [],
                "",
                truncate(narration.output, ACTIVITY_DETAIL_LIMIT),
                narration.sequence,
                "completed",
                narration.activityType === "reasoning" ? "Reasoning" : "Progress update",
                narration.activityType === "reasoning" ? "think" : "",
                previous?.content ?? [],
                detail,
            ),
        );
    };

    readonly #identity = (key: string): ActivityIdentity => {
        const existing = this.#identities.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const identity = new ActivityIdentity(`activity-${crypto.randomUUID()}`, this.#nextSequence);
        this.#nextSequence += 1;
        this.#identities.set(key, identity);
        return identity;
    };

    readonly #record = async (key: string, activity: AcpActivity): Promise<void> => {
        this.#activities.set(key, activity);
        await this.#onActivity(activity);
    };

    readonly #recordPlanEntries = async (key: string, entries: readonly PlanEntry[]): Promise<void> => {
        const identity = this.#identity(key);
        await this.#record(
            key,
            new AcpActivity(
                identity.id,
                "plan",
                "",
                [],
                "",
                formatPlanEntries(entries),
                identity.sequence,
                planStatus(entries),
                "Plan",
                "",
            ),
        );
    };
}
