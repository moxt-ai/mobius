import type {
  ContentBlock,
  ContentChunk,
  Plan,
  PlanEntry,
  PlanRemoved,
  PlanUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import {
  AGENT_ACTIVITY_DETAIL_LIMIT,
  AGENT_ACTIVITY_LOCATION_LENGTH_LIMIT,
  AGENT_ACTIVITY_LOCATION_LIMIT,
  type AgentDisplayContent,
} from "@moxt-ai/mobius-protocol";

const TRUNCATION_MARKER = "\n… output truncated by Mobius";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  return `${value.slice(0, maximumLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return truncate(value, AGENT_ACTIVITY_DETAIL_LIMIT);
  }
  try {
    const encoded = JSON.stringify(value, null, 2);
    return truncate(encoded ?? "", AGENT_ACTIVITY_DETAIL_LIMIT);
  } catch {
    return truncate(String(value), AGENT_ACTIVITY_DETAIL_LIMIT);
  }
}

function readContentOutput(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }
  return formatUnknown(content);
}

function emptyDisplayContent(
  type: AgentDisplayContent["type"],
): AgentDisplayContent {
  return {
    data: "",
    mimeType: "",
    name: "",
    newText: "",
    oldText: "",
    path: "",
    terminalId: "",
    text: "",
    type,
    uri: "",
  };
}

export function normalizeContentBlock(
  content: ContentBlock,
): AgentDisplayContent {
  if (content.type === "text") {
    return { ...emptyDisplayContent("text"), text: content.text };
  }
  if (content.type === "image") {
    return {
      ...emptyDisplayContent("image"),
      data: content.data,
      mimeType: content.mimeType,
      uri: content.uri ?? "",
    };
  }
  if (content.type === "resource_link") {
    return {
      ...emptyDisplayContent("resource_link"),
      mimeType: content.mimeType ?? "",
      name: content.name,
      uri: content.uri,
    };
  }
  if (content.type === "resource") {
    if ("text" in content.resource) {
      return {
        ...emptyDisplayContent("resource"),
        mimeType: content.resource.mimeType ?? "",
        text: content.resource.text,
        uri: content.resource.uri,
      };
    }
    return {
      ...emptyDisplayContent("resource"),
      data: content.resource.blob,
      mimeType: content.resource.mimeType ?? "",
      uri: content.resource.uri,
    };
  }
  return {
    ...emptyDisplayContent("resource"),
    data: content.data,
    mimeType: content.mimeType,
  };
}

function normalizeToolContent(
  content: readonly ToolCallContent[],
): readonly AgentDisplayContent[] {
  const normalized: AgentDisplayContent[] = [];
  for (const item of content) {
    if (item.type === "diff") {
      normalized.push({
        ...emptyDisplayContent("diff"),
        newText: item.newText,
        oldText: item.oldText ?? "",
        path: item.path,
      });
      continue;
    }
    if (item.type === "terminal") {
      normalized.push({
        ...emptyDisplayContent("terminal"),
        terminalId: item.terminalId,
      });
      continue;
    }
    normalized.push(normalizeContentBlock(item.content));
  }
  return normalized;
}

function normalizeLocations(
  locations: readonly ToolCallLocation[],
): readonly string[] {
  const normalized: string[] = [];
  const unique = new Set<string>();
  for (const location of locations) {
    if (normalized.length === AGENT_ACTIVITY_LOCATION_LIMIT) {
      break;
    }
    const suffix =
      typeof location.line === "number" ? `:${location.line.toString()}` : "";
    const value = truncate(
      `${location.path}${suffix}`,
      AGENT_ACTIVITY_LOCATION_LENGTH_LIMIT,
    );
    if (value.length > 0 && !unique.has(value)) {
      unique.add(value);
      normalized.push(value);
    }
  }
  return normalized;
}

function normalizeToolStatus(status: string, fallback: string): string {
  if (status === "pending") {
    return "pending";
  }
  if (status === "in_progress") {
    return "running";
  }
  if (status === "completed" || status === "failed") {
    return status;
  }
  return fallback;
}

function normalizeTitle(title: string, fallback: string): string {
  const normalized = title.trim();
  return truncate(normalized.length === 0 ? fallback : normalized, 500);
}

function formatPlanEntries(entries: readonly PlanEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`[${entry.status}] ${entry.content}`);
  }
  return truncate(lines.join("\n"), AGENT_ACTIVITY_DETAIL_LIMIT);
}

function planStatus(entries: readonly PlanEntry[]): string {
  if (entries.length === 0) {
    return "completed";
  }
  if (entries.every((entry) => entry.status === "completed")) {
    return "completed";
  }
  if (entries.some((entry) => entry.status === "in_progress")) {
    return "running";
  }
  return "pending";
}

function contentPhase(content: ContentChunk): string {
  const metadata = content._meta;
  if (metadata === undefined || metadata === null) {
    return "";
  }
  const codex = metadata["codex"];
  if (!isRecord(codex)) {
    return "";
  }
  const phase = codex["phase"];
  return typeof phase === "string" ? phase : "";
}

export function isProgressMessage(content: ContentChunk): boolean {
  return contentPhase(content) === "commentary";
}

export class AcpActivityTracker {
  readonly #activities = new Map<string, AcpActivity>();
  readonly #identities = new Map<string, ActivityIdentity>();
  readonly #onActivity: (activity: AcpActivity) => Promise<void>;
  #activeNarrativeKey = "";
  #nextSequence = 0;

  constructor(onActivity: (activity: AcpActivity) => Promise<void>) {
    this.#onActivity = onActivity;
  }

  readonly recordNarrative = async (
    activityType: string,
    messageId: string,
    text: string,
  ): Promise<void> => {
    const key = `${activityType}:${messageId}`;
    if (this.#activeNarrativeKey !== key) {
      await this.finishNarrative();
    }
    const previous = this.#activities.get(key);
    const identity = this.#identity(key);
    const activity = new AcpActivity(
      identity.id,
      activityType,
      "",
      [],
      "",
      truncate(`${previous?.output ?? ""}${text}`, AGENT_ACTIVITY_DETAIL_LIMIT),
      identity.sequence,
      "running",
      activityType === "reasoning" ? "Reasoning" : "Progress update",
      activityType === "reasoning" ? "think" : "",
    );
    await this.#record(key, activity);
    this.#activeNarrativeKey = key;
  };

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
    const output =
      plan.type === "markdown" ? plan.content : `Plan file: ${plan.uri}`;
    await this.#record(
      key,
      new AcpActivity(
        identity.id,
        "plan",
        "",
        [],
        "",
        truncate(output, AGENT_ACTIVITY_DETAIL_LIMIT),
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
        ),
      );
    }
  };

  readonly recordToolCall = async (update: ToolCall): Promise<void> => {
    await this.finishNarrative();
    const key = `tool:${update.toolCallId}`;
    const identity = this.#identity(key);
    const output =
      update.rawOutput === undefined
        ? readContentOutput(update.content)
        : formatUnknown(update.rawOutput);
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
        normalizeToolContent(update.content ?? []),
      ),
    );
  };

  readonly recordToolCallUpdate = async (
    update: ToolCallUpdate,
  ): Promise<void> => {
    await this.finishNarrative();
    const key = `tool:${update.toolCallId}`;
    const previous = this.#activities.get(key);
    const identity = this.#identity(key);
    const output =
      update.rawOutput !== undefined
        ? formatUnknown(update.rawOutput)
        : update.content !== undefined && update.content !== null
          ? readContentOutput(update.content)
          : (previous?.output ?? "");
    const content =
      update.content === undefined || update.content === null
        ? (previous?.content ?? [])
        : normalizeToolContent(update.content);
    await this.#record(
      key,
      new AcpActivity(
        identity.id,
        "tool",
        update.rawInput === undefined
          ? (previous?.input ?? "")
          : formatUnknown(update.rawInput),
        update.locations === undefined || update.locations === null
          ? (previous?.locations ?? [])
          : normalizeLocations(update.locations),
        update.name === undefined || update.name === null
          ? (previous?.name ?? "")
          : truncate(update.name, 128),
        output,
        identity.sequence,
        update.status === undefined || update.status === null
          ? (previous?.status ?? "pending")
          : normalizeToolStatus(update.status, previous?.status ?? "pending"),
        update.title === undefined || update.title === null
          ? (previous?.title ?? "Tool call")
          : normalizeTitle(update.title, "Tool call"),
        update.kind === undefined || update.kind === null
          ? (previous?.toolKind ?? "other")
          : update.kind,
        content,
      ),
    );
  };

  readonly finishNarrative = async (): Promise<void> => {
    const key = this.#activeNarrativeKey;
    if (key.length === 0) {
      return;
    }
    this.#activeNarrativeKey = "";
    const activity = this.#activities.get(key);
    if (activity === undefined) {
      return;
    }
    const completed = activity.complete();
    if (completed !== activity) {
      await this.#record(key, completed);
    }
  };

  readonly finish = async (): Promise<void> => {
    await this.finishNarrative();
    const entries = [...this.#activities.entries()].sort(
      (left, right) => left[1].sequence - right[1].sequence,
    );
    for (const [key, activity] of entries) {
      const completed = activity.complete();
      if (completed !== activity) {
        await this.#record(key, completed);
      }
    }
  };

  readonly #identity = (key: string): ActivityIdentity => {
    const existing = this.#identities.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const identity = new ActivityIdentity(
      `activity-${crypto.randomUUID()}`,
      this.#nextSequence,
    );
    this.#nextSequence += 1;
    this.#identities.set(key, identity);
    return identity;
  };

  readonly #record = async (
    key: string,
    activity: AcpActivity,
  ): Promise<void> => {
    this.#activities.set(key, activity);
    await this.#onActivity(activity);
  };

  readonly #recordPlanEntries = async (
    key: string,
    entries: readonly PlanEntry[],
  ): Promise<void> => {
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
