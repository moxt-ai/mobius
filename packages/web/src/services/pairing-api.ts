import {
  AgentOption,
  type BrowserPairingStatus,
  ChannelConnection,
  ChannelHistory,
  CompletedRecordedTurn,
  ConnectedBrowserPairingStatus,
  CreatedPairing,
  ExpiredBrowserPairingStatus,
  FailedRecordedTurn,
  isIdentifier,
  isPairingCode,
  isToken,
  PairingApiError,
  PendingRecordedTurn,
  RecordedActivity,
  type RecordedTurn,
  RunningRecordedTurn,
  WaitingBrowserPairingStatus,
} from "@/domain/channel";

const REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const ACTIVITY_TYPES = new Set(["plan", "progress", "reasoning", "tool"]);
const ACTIVITY_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
]);
const TOOL_KINDS = new Set([
  "",
  "delete",
  "edit",
  "execute",
  "fetch",
  "move",
  "other",
  "read",
  "search",
  "switch_mode",
  "think",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestJson(
  url: URL,
  init: RequestInit,
  signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal,
    });
  } catch (error) {
    throw new PairingApiError(
      "relay_unavailable",
      "The pairing relay could not be reached.",
      { cause: error },
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The pairing relay returned an invalid response.",
      { cause: error },
    );
  }
  if (!response.ok) {
    if (isRecord(value) && isRecord(value["error"])) {
      const code = value["error"]["code"];
      const message = value["error"]["message"];
      if (typeof code === "string" && typeof message === "string") {
        throw new PairingApiError(code, message);
      }
    }
    throw new PairingApiError(
      "pairing_failed",
      "The pairing relay rejected the request.",
    );
  }
  return value;
}

function readDate(value: unknown, field: string): Date {
  if (typeof value !== "string") {
    throw new PairingApiError(
      "invalid_relay_response",
      `The relay returned an invalid ${field}.`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PairingApiError(
      "invalid_relay_response",
      `The relay returned an invalid ${field}.`,
    );
  }
  return date;
}

function readString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      `The relay returned an invalid ${field}.`,
    );
  }
  return value;
}

function readText(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new PairingApiError(
      "invalid_relay_response",
      `The relay returned an invalid ${field}.`,
    );
  }
  return value;
}

function readIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !isIdentifier(value)) {
    throw new PairingApiError(
      "invalid_relay_response",
      `The relay returned an invalid ${field}.`,
    );
  }
  return value;
}

function readAllowedString(
  value: unknown,
  field: string,
  allowedValues: ReadonlySet<string>,
): string {
  const text = readText(value, field, 64);
  if (!allowedValues.has(text)) {
    throw new PairingApiError(
      "invalid_relay_response",
      `The relay returned an invalid ${field}.`,
    );
  }
  return text;
}

function decodeRecordedActivity(value: unknown): RecordedActivity {
  if (!isRecord(value)) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid agent activity.",
    );
  }
  const sequence = value["sequence"];
  const locationsValue = value["locations"];
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !Array.isArray(locationsValue) ||
    locationsValue.length > 12
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned invalid agent activity details.",
    );
  }
  const locations: string[] = [];
  const uniqueLocations = new Set<string>();
  for (const location of locationsValue) {
    const normalized = readString(location, "agent activity location", 1_024);
    if (uniqueLocations.has(normalized)) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned a duplicate agent activity location.",
      );
    }
    uniqueLocations.add(normalized);
    locations.push(normalized);
  }
  return new RecordedActivity(
    readIdentifier(value["activityId"], "agent activity"),
    readAllowedString(
      value["activityType"],
      "agent activity type",
      ACTIVITY_TYPES,
    ),
    readText(value["input"], "agent activity input", 24_000),
    locations,
    readText(value["name"], "agent activity name", 128),
    readText(value["output"], "agent activity output", 24_000),
    sequence,
    readAllowedString(
      value["status"],
      "agent activity status",
      ACTIVITY_STATUSES,
    ),
    readString(value["title"], "agent activity title", 500),
    readAllowedString(value["toolKind"], "agent tool kind", TOOL_KINDS),
  );
}

function decodeRecordedActivities(value: unknown): readonly RecordedActivity[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 2_000) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned invalid agent activities.",
    );
  }
  const activities: RecordedActivity[] = [];
  const identifiers = new Set<string>();
  for (const candidate of value) {
    const activity = decodeRecordedActivity(candidate);
    if (identifiers.has(activity.activityId)) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned a duplicate agent activity.",
      );
    }
    identifiers.add(activity.activityId);
    activities.push(activity);
  }
  activities.sort((left, right) => left.sequence - right.sequence);
  return activities;
}

function decodeAgents(value: unknown): readonly AgentOption[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid agent directory.",
    );
  }
  const agents: AgentOption[] = [];
  const identifiers = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned an invalid agent directory.",
      );
    }
    const id = candidate["id"];
    const label = candidate["label"];
    if (
      typeof id !== "string" ||
      !isIdentifier(id) ||
      identifiers.has(id) ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      label.length > 80
    ) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned an invalid agent directory.",
      );
    }
    identifiers.add(id);
    agents.push(new AgentOption(id, label.trim()));
  }
  return agents;
}

function decodeCreatedPairing(value: unknown): CreatedPairing {
  if (!isRecord(value)) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid pairing request.",
    );
  }
  const pairingId = value["pairingId"];
  const pairingCode = value["pairingCode"];
  const pollToken = value["pollToken"];
  const channelId = value["channelId"];
  if (
    typeof pairingId !== "string" ||
    !isIdentifier(pairingId) ||
    typeof pairingCode !== "string" ||
    !isPairingCode(pairingCode) ||
    typeof pollToken !== "string" ||
    !isToken(pollToken) ||
    typeof channelId !== "string" ||
    !isIdentifier(channelId)
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid pairing request.",
    );
  }
  return new CreatedPairing(
    pairingId,
    pairingCode,
    pollToken,
    channelId,
    readDate(value["expiresAt"], "expiry time"),
  );
}

function decodeChannelConnection(
  value: unknown,
  expectedChannelId: string,
): ChannelConnection {
  if (!isRecord(value)) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid channel.",
    );
  }
  const channelId = value["channelId"];
  if (
    typeof channelId !== "string" ||
    !isIdentifier(channelId) ||
    channelId !== expectedChannelId
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid channel.",
    );
  }
  return new ChannelConnection(
    decodeAgents(value["agents"]),
    channelId,
    readString(value["machineName"], "machine name", 120),
    readString(value["workspaceName"], "workspace name", 120),
  );
}

function decodeRecordedTurn(value: unknown): RecordedTurn {
  if (!isRecord(value)) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid conversation history.",
    );
  }
  const agentId = readIdentifier(value["agentId"], "history agent");
  const commandId = readIdentifier(value["commandId"], "history command");
  const createdAt = readDate(value["createdAt"], "history timestamp");
  const prompt = readString(value["prompt"], "history prompt", 10_000);
  const response = readText(value["response"], "history response", 100_000);
  const sessionId = readIdentifier(value["sessionId"], "history session");
  const activities = decodeRecordedActivities(value["activities"]);
  const status = value["status"];
  if (status === "pending") {
    return new PendingRecordedTurn(
      agentId,
      commandId,
      createdAt,
      prompt,
      response,
      sessionId,
      activities,
    );
  }
  if (status === "running") {
    return new RunningRecordedTurn(
      agentId,
      commandId,
      createdAt,
      prompt,
      response,
      sessionId,
      readIdentifier(value["processAttemptId"], "history attempt"),
      activities,
    );
  }
  if (status === "completed") {
    return new CompletedRecordedTurn(
      agentId,
      commandId,
      createdAt,
      prompt,
      response,
      sessionId,
      readIdentifier(value["processAttemptId"], "history attempt"),
      readString(value["stopReason"], "history stop reason", 64),
      activities,
    );
  }
  if (status === "failed") {
    return new FailedRecordedTurn(
      agentId,
      commandId,
      createdAt,
      prompt,
      response,
      sessionId,
      readIdentifier(value["code"], "history error code"),
      readString(value["message"], "history error message", 500),
      activities,
    );
  }
  throw new PairingApiError(
    "invalid_relay_response",
    "The relay returned an invalid conversation history state.",
  );
}

function decodeChannelHistory(
  value: unknown,
  channelId: string,
): ChannelHistory {
  if (
    !isRecord(value) ||
    value["runtimeId"] !== channelId ||
    !Array.isArray(value["turns"]) ||
    value["turns"].length > 500
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid conversation history.",
    );
  }
  const turns: RecordedTurn[] = [];
  const commandIds = new Set<string>();
  for (const candidate of value["turns"]) {
    const turn = decodeRecordedTurn(candidate);
    if (commandIds.has(turn.commandId)) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned a duplicate conversation turn.",
      );
    }
    commandIds.add(turn.commandId);
    turns.push(turn);
  }
  return new ChannelHistory(turns);
}

export async function createBrowserPairing(): Promise<CreatedPairing> {
  return decodeCreatedPairing(
    await requestJson(new URL("/v1/pairings", window.location.origin), {
      method: "POST",
    }),
  );
}

export async function readBrowserPairingStatus(
  pairing: CreatedPairing,
): Promise<BrowserPairingStatus> {
  const endpoint = new URL(
    `/v1/pairings/${encodeURIComponent(pairing.pairingId)}`,
    window.location.origin,
  );
  endpoint.searchParams.set("token", pairing.pollToken);
  const value = await requestJson(endpoint, { method: "GET" });
  if (!isRecord(value) || typeof value["status"] !== "string") {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid pairing status.",
    );
  }
  if (value["status"] === "pending") {
    return new WaitingBrowserPairingStatus(
      readDate(value["expiresAt"], "expiry time"),
    );
  }
  if (value["status"] === "expired") {
    return new ExpiredBrowserPairingStatus();
  }
  if (value["status"] !== "paired") {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an unknown pairing status.",
    );
  }
  return new ConnectedBrowserPairingStatus(
    decodeChannelConnection(value, pairing.channelId),
  );
}

export async function readChannelConnection(
  channelId: string,
): Promise<ChannelConnection> {
  const endpoint = new URL(
    `/v1/channels/${encodeURIComponent(channelId)}`,
    window.location.origin,
  );
  return decodeChannelConnection(
    await requestJson(endpoint, { method: "GET" }),
    channelId,
  );
}

export async function readChannelHistory(
  channelId: string,
): Promise<ChannelHistory> {
  return await readChannelHistoryWithSignal(
    channelId,
    AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  );
}

async function readChannelHistoryWithSignal(
  channelId: string,
  signal: AbortSignal,
): Promise<ChannelHistory> {
  const endpoint = new URL(
    `/v1/channels/${encodeURIComponent(channelId)}/history`,
    window.location.origin,
  );
  return decodeChannelHistory(
    await requestJson(endpoint, { method: "GET" }, signal),
    channelId,
  );
}

export async function readChannelHistoryForSynchronization(
  channelId: string,
  cancellationSignal: AbortSignal,
): Promise<ChannelHistory> {
  return await readChannelHistoryWithSignal(
    channelId,
    AbortSignal.any([
      cancellationSignal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    ]),
  );
}

export function pairingCommand(pairing: CreatedPairing): string {
  return `npx --yes @moxt-ai/mobius pair --url ${JSON.stringify(window.location.origin)} --code ${pairing.pairingCode} --root "$PWD"`;
}
