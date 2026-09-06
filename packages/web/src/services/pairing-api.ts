import {
  decodeAgentDisplayContentValue,
  decodePromptImagesValue,
  decodePromptResourcesValue,
  decodeRecordedAgentContentValue,
} from "@moxt-ai/mobius-web-sdk";

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
  InstallableAgentOption,
  isIdentifier,
  isPairingCode,
  isToken,
  PairingApiError,
  PendingRecordedTurn,
  RecordedActivity,
  RecordedContent,
  type RecordedTurn,
  RunningRecordedTurn,
  WaitingBrowserPairingStatus,
} from "@/domain/channel";

const REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const CHANNEL_CREDENTIAL_PREFIX = "mobius:channel-credential:";
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

export type ActivityDetailResult =
  | {
      readonly artifactId: string;
      readonly content: readonly ReturnType<
        typeof decodeRecordedAgentContentValue
      >[];
      readonly input: string;
      readonly kind: "available";
      readonly output: string;
      readonly storage: "archive" | "hot";
    }
  | {
      readonly capturedBytes: number;
      readonly kind: "truncated";
      readonly originalBytes: number;
    }
  | { readonly kind: "unrecorded" }
  | { readonly deletedAt: Date; readonly kind: "deleted" };

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
  const contentValue = value["content"] ?? [];
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !Array.isArray(locationsValue) ||
    locationsValue.length > 12 ||
    !Array.isArray(contentValue) ||
    contentValue.length > 500
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned invalid agent activity details.",
    );
  }
  const content = contentValue.map((entry) =>
    decodeAgentDisplayContentValue(entry),
  );
  const detailAvailability = value["detailAvailability"];
  if (
    detailAvailability !== "available" &&
    detailAvailability !== "truncated" &&
    detailAvailability !== "unrecorded"
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned invalid activity detail availability.",
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
    content,
    detailAvailability,
  );
}

function decodeRecordedContents(value: unknown): readonly RecordedContent[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 2_000) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned invalid agent content.",
    );
  }
  const contents: RecordedContent[] = [];
  const identifiers = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned invalid agent content.",
      );
    }
    const contentId = readIdentifier(
      candidate["contentId"],
      "agent content identifier",
    );
    if (identifiers.has(contentId)) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned duplicate agent content.",
      );
    }
    identifiers.add(contentId);
    contents.push(
      new RecordedContent(
        readIdentifier(candidate["commandId"], "agent content command"),
        contentId,
        readText(candidate["messageId"], "agent content message", 255),
        decodeAgentDisplayContentValue(candidate["content"]),
      ),
    );
  }
  return contents;
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
  if (!Array.isArray(value) || value.length > 8) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid agent directory.",
    );
  }
  const agents: AgentOption[] = [];
  const identifiers = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 2 ||
      !Object.hasOwn(candidate, "id") ||
      !Object.hasOwn(candidate, "label")
    ) {
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

function decodeInstallableAgents(
  value: unknown,
): readonly InstallableAgentOption[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid installable Agent directory.",
    );
  }
  const agents: InstallableAgentOption[] = [];
  const identifiers = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 3 ||
      !Object.hasOwn(candidate, "id") ||
      !Object.hasOwn(candidate, "label") ||
      !Object.hasOwn(candidate, "requiresLocalApproval")
    ) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned an invalid installable Agent directory.",
      );
    }
    const id = candidate["id"];
    const label = candidate["label"];
    const requiresLocalApproval = candidate["requiresLocalApproval"];
    if (
      typeof id !== "string" ||
      !isIdentifier(id) ||
      identifiers.has(id) ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      label.length > 80 ||
      typeof requiresLocalApproval !== "boolean"
    ) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned an invalid installable Agent directory.",
      );
    }
    identifiers.add(id);
    agents.push(
      new InstallableAgentOption(id, label.trim(), requiresLocalApproval),
    );
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
  const hostToken = value["hostToken"];
  const tenantId = value["tenantId"];
  const projectId = value["projectId"];
  if (
    typeof pairingId !== "string" ||
    !isIdentifier(pairingId) ||
    typeof pairingCode !== "string" ||
    !isPairingCode(pairingCode) ||
    typeof pollToken !== "string" ||
    !isToken(pollToken) ||
    typeof channelId !== "string" ||
    !isIdentifier(channelId) ||
    typeof hostToken !== "string" ||
    !isToken(hostToken) ||
    typeof tenantId !== "string" ||
    !isIdentifier(tenantId) ||
    typeof projectId !== "string" ||
    !isIdentifier(projectId)
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
    hostToken,
    tenantId,
    projectId,
  );
}

interface BrowserChannelCredential {
  readonly hostToken: string;
  readonly projectId: string;
  readonly tenantId: string;
}

function saveChannelCredential(pairing: CreatedPairing): void {
  window.localStorage.setItem(
    `${CHANNEL_CREDENTIAL_PREFIX}${pairing.channelId}`,
    JSON.stringify({
      hostToken: pairing.hostToken,
      projectId: pairing.projectId,
      tenantId: pairing.tenantId,
    }),
  );
}

function readChannelCredential(channelId: string): BrowserChannelCredential {
  let value: unknown;
  try {
    const encoded = window.localStorage.getItem(
      `${CHANNEL_CREDENTIAL_PREFIX}${channelId}`,
    );
    value = encoded === null ? null : JSON.parse(encoded);
  } catch (cause) {
    throw new PairingApiError(
      "channel_credential_invalid",
      "The saved channel credential is invalid.",
      { cause },
    );
  }
  if (!isRecord(value)) {
    throw new PairingApiError(
      "channel_credential_missing",
      "This browser does not have access to the channel.",
    );
  }
  const hostToken = value["hostToken"];
  const tenantId = value["tenantId"];
  const projectId = value["projectId"];
  if (
    typeof hostToken !== "string" ||
    !isToken(hostToken) ||
    typeof tenantId !== "string" ||
    !isIdentifier(tenantId) ||
    typeof projectId !== "string" ||
    !isIdentifier(projectId)
  ) {
    throw new PairingApiError(
      "channel_credential_invalid",
      "The saved channel credential is invalid.",
    );
  }
  return { hostToken, projectId, tenantId };
}

function decodeChannelConnection(
  value: unknown,
  expectedChannelId: string,
  credential: BrowserChannelCredential,
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
  if (
    value["tenantId"] !== credential.tenantId ||
    value["projectId"] !== credential.projectId
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned a channel from another project.",
    );
  }
  const agents = decodeAgents(value["agents"]);
  const installableAgents = decodeInstallableAgents(value["installableAgents"]);
  if (
    agents.length + installableAgents.length === 0 ||
    installableAgents.some((agent) =>
      agents.some((available) => available.id === agent.id),
    )
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid Agent catalog.",
    );
  }
  return new ChannelConnection(
    agents,
    channelId,
    readString(value["machineName"], "machine name", 120),
    readString(value["workspaceName"], "workspace name", 120),
    credential.hostToken,
    credential.tenantId,
    credential.projectId,
    installableAgents,
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
  const prompt = readText(value["prompt"], "history prompt", 10_000);
  const response = readText(value["response"], "history response", 100_000);
  const sessionId = readIdentifier(value["sessionId"], "history session");
  const activities = decodeRecordedActivities(value["activities"]);
  const images = decodePromptImagesValue(value["images"] ?? []);
  const resources = decodePromptResourcesValue(value["resources"] ?? []);
  const contents = decodeRecordedContents(value["contents"]);
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
      images,
      resources,
      contents,
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
      images,
      resources,
      contents,
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
      images,
      resources,
      contents,
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
      images,
      resources,
      contents,
    );
  }
  throw new PairingApiError(
    "invalid_relay_response",
    "The relay returned an invalid conversation history state.",
  );
}

export async function createBrowserPairing(): Promise<CreatedPairing> {
  const pairing = decodeCreatedPairing(
    await requestJson(new URL("/v1/pairings", window.location.origin), {
      method: "POST",
    }),
  );
  saveChannelCredential(pairing);
  return pairing;
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
    decodeChannelConnection(value, pairing.channelId, {
      hostToken: pairing.hostToken,
      projectId: pairing.projectId,
      tenantId: pairing.tenantId,
    }),
  );
}

export async function readChannelConnection(
  channelId: string,
): Promise<ChannelConnection> {
  const credential = readChannelCredential(channelId);
  const endpoint = new URL(
    `/v1/channels/${encodeURIComponent(channelId)}`,
    window.location.origin,
  );
  return decodeChannelConnection(
    await requestJson(endpoint, {
      headers: { authorization: `Bearer ${credential.hostToken}` },
      method: "GET",
    }),
    channelId,
    credential,
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
  const credential = readChannelCredential(channelId);
  const headers = { authorization: `Bearer ${credential.hostToken}` };
  const directoryEndpoint = new URL(
    `/v1/projects/${encodeURIComponent(credential.projectId)}/sessions`,
    window.location.origin,
  );
  directoryEndpoint.searchParams.set("limit", "100");
  const directory = await requestJson(
    directoryEndpoint,
    { headers, method: "GET" },
    signal,
  );
  if (!isRecord(directory) || !Array.isArray(directory["sessions"])) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid session directory.",
    );
  }
  const sessionIds = directory["sessions"].map((session) => {
    if (!isRecord(session)) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned an invalid session summary.",
      );
    }
    return readIdentifier(session["sessionId"], "session identifier");
  });
  const pages = await Promise.all(
    sessionIds.map(async (sessionId) => {
      const endpoint = new URL(
        `/v1/projects/${encodeURIComponent(credential.projectId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
        window.location.origin,
      );
      endpoint.searchParams.set("limit", "100");
      return await requestJson(endpoint, { headers, method: "GET" }, signal);
    }),
  );
  const turns: RecordedTurn[] = [];
  for (const page of pages) {
    if (!isRecord(page) || !Array.isArray(page["messages"])) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned an invalid message page.",
      );
    }
    const sessionTurns: RecordedTurn[] = [];
    for (const message of page["messages"]) {
      sessionTurns.push(decodeSessionMessage(message));
    }
    sessionTurns.sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    turns.push(...sessionTurns);
  }
  return new ChannelHistory(turns);
}

function decodeSessionMessage(value: unknown): RecordedTurn {
  if (!isRecord(value) || !Array.isArray(value["activities"])) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid session message.",
    );
  }
  const base = {
    activities: value["activities"],
    agentId: value["agentId"],
    commandId: value["commandId"],
    contents: [],
    createdAt: value["createdAt"],
    images: [],
    prompt: value["prompt"],
    resources: [],
    response: value["response"],
    sessionId: value["sessionId"],
  };
  const attempt = value["attempt"];
  if (attempt === null) {
    return decodeRecordedTurn({ ...base, status: "pending" });
  }
  if (!isRecord(attempt) || typeof attempt["kind"] !== "string") {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned an invalid execution attempt.",
    );
  }
  if (attempt["kind"] === "running") {
    return decodeRecordedTurn({
      ...base,
      processAttemptId: attempt["processAttemptId"],
      status: "running",
    });
  }
  if (attempt["kind"] === "completed") {
    return decodeRecordedTurn({
      ...base,
      processAttemptId: attempt["processAttemptId"],
      status: "completed",
      stopReason: attempt["stopReason"],
    });
  }
  if (attempt["kind"] === "failed") {
    return decodeRecordedTurn({
      ...base,
      code: attempt["code"],
      message: attempt["message"],
      status: "failed",
    });
  }
  if (attempt["kind"] === "outcome_unknown") {
    return decodeRecordedTurn({
      ...base,
      code: "outcome_unknown",
      message:
        "The runtime disconnected before the execution outcome was reconciled.",
      status: "failed",
    });
  }
  throw new PairingApiError(
    "invalid_relay_response",
    "The relay returned an unknown execution attempt state.",
  );
}

function decodeActivityDetail(value: unknown): ActivityDetailResult {
  if (!isRecord(value)) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned invalid activity details.",
    );
  }
  const kind = value["kind"];
  if (kind === "unrecorded") {
    return { kind };
  }
  if (kind === "deleted") {
    return {
      deletedAt: readDate(value["deletedAt"], "activity deletion time"),
      kind,
    };
  }
  if (kind === "truncated") {
    const capturedBytes = value["capturedBytes"];
    const originalBytes = value["originalBytes"];
    if (
      typeof capturedBytes !== "number" ||
      !Number.isSafeInteger(capturedBytes) ||
      capturedBytes < 0 ||
      typeof originalBytes !== "number" ||
      !Number.isSafeInteger(originalBytes) ||
      originalBytes < capturedBytes
    ) {
      throw new PairingApiError(
        "invalid_relay_response",
        "The relay returned invalid truncation details.",
      );
    }
    return { capturedBytes, kind, originalBytes };
  }
  const content = value["content"];
  const storage = value["storage"];
  if (
    kind !== "available" ||
    !Array.isArray(content) ||
    content.length > 100 ||
    (storage !== "archive" && storage !== "hot")
  ) {
    throw new PairingApiError(
      "invalid_relay_response",
      "The relay returned invalid activity details.",
    );
  }
  return {
    artifactId: readIdentifier(value["artifactId"], "activity artifact"),
    content: content.map(decodeRecordedAgentContentValue),
    input: readText(value["input"], "activity input", 4_000_000),
    kind,
    output: readText(value["output"], "activity output", 4_000_000),
    storage,
  };
}

export async function readActivityDetail(
  channelId: string,
  sessionId: string,
  activityId: string,
  signal: AbortSignal,
): Promise<ActivityDetailResult> {
  const credential = readChannelCredential(channelId);
  const endpoint = new URL(
    `/v1/projects/${encodeURIComponent(credential.projectId)}/sessions/${encodeURIComponent(sessionId)}/activities/${encodeURIComponent(activityId)}`,
    window.location.origin,
  );
  return decodeActivityDetail(
    await requestJson(
      endpoint,
      {
        headers: { authorization: `Bearer ${credential.hostToken}` },
        method: "GET",
      },
      signal,
    ),
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
  return `npx --yes @moxt-ai/mobius pair --url ${JSON.stringify(window.location.origin)} --code ${pairing.pairingCode}`;
}
