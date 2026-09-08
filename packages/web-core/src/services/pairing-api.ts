import {
    decodeAgentDisplayContentValue,
    decodeInteraction,
    decodeNativeSessionHistory,
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeRecordedAgentContentValue,
    type Interaction,
    mobiusApiUrl,
    type SessionElicitationRequestedEvent,
    type SessionPermissionRequestedEvent,
} from "@moxt-ai/mobius-web-sdk";

import {
    AgentIntegrationOption,
    AgentOption,
    type BrowserPairingStatus,
    ChannelConnection,
    ChannelHistory,
    CompletedRecordedTurn,
    ConnectedBrowserPairingStatus,
    CreatedChannelAccessGrant,
    CreatedPairing,
    ExpiredBrowserPairingStatus,
    FailedRecordedTurn,
    type InstallableAgentOption,
    isIdentifier,
    isPairingCode,
    isToken,
    LinkedChannelDevice,
    MissingAgentOption,
    PairingApiError,
    PendingRecordedTurn,
    RecordedActivity,
    RecordedContent,
    RecordedSession,
    type RecordedTurn,
    RunningRecordedTurn,
    WaitingBrowserPairingStatus,
} from "@/domain/channel";

const REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const CHANNEL_CREDENTIAL_PREFIX = "mobius:channel-credential:";
const DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
const DECIMAL_SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const ACTIVITY_TYPES = new Set(["plan", "progress", "reasoning", "tool"]);
const ACTIVITY_STATUSES = new Set(["pending", "running", "completed", "failed"]);
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
          readonly content: readonly ReturnType<typeof decodeRecordedAgentContentValue>[];
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
        if (signal.aborted) {
            throw error;
        }
        throw new PairingApiError("relay_unavailable", "The pairing relay could not be reached.", { cause: error });
    }

    let value: unknown;
    try {
        value = await response.json();
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        throw new PairingApiError("invalid_relay_response", "The pairing relay returned an invalid response.", {
            cause: error,
        });
    }
    if (!response.ok) {
        if (isRecord(value) && isRecord(value["error"])) {
            const code = value["error"]["code"];
            const message = value["error"]["message"];
            if (typeof code === "string" && typeof message === "string") {
                throw new PairingApiError(code, message);
            }
        }
        throw new PairingApiError("pairing_failed", "The pairing relay rejected the request.");
    }
    return value;
}

async function requestEmpty(
    url: URL,
    init: RequestInit,
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
): Promise<void> {
    let response: Response;
    try {
        response = await fetch(url, { ...init, signal });
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        throw new PairingApiError("relay_unavailable", "The pairing relay could not be reached.", { cause: error });
    }
    if (response.ok) {
        return;
    }
    let value: unknown;
    try {
        value = await response.json();
    } catch (error) {
        throw new PairingApiError("invalid_relay_response", "The pairing relay returned an invalid response.", {
            cause: error,
        });
    }
    if (isRecord(value) && isRecord(value["error"])) {
        const code = value["error"]["code"];
        const message = value["error"]["message"];
        if (typeof code === "string" && typeof message === "string") {
            throw new PairingApiError(code, message);
        }
    }
    throw new PairingApiError("pairing_failed", "The pairing relay rejected the request.");
}

function readDate(value: unknown, field: string): Date {
    if (typeof value !== "string") {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return date;
}

function readString(value: unknown, field: string, maximumLength: number): string {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return value;
}

function readText(value: unknown, field: string, maximumLength: number): string {
    if (typeof value !== "string" || value.length > maximumLength) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return value;
}

function readIdentifier(value: unknown, field: string): string {
    if (typeof value !== "string" || !isIdentifier(value)) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return value;
}

function readCommittedSequence(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length > 40 || !DECIMAL_SEQUENCE_PATTERN.test(value)) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return value;
}

function readAdditionalDirectoryIds(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length > 16) {
        throw new PairingApiError(
            "invalid_relay_response",
            "The relay returned invalid additional Session workspaces.",
        );
    }
    const directoryIds: string[] = [];
    for (const directoryId of value) {
        if (typeof directoryId !== "string" || !DIRECTORY_IDENTIFIER_PATTERN.test(directoryId)) {
            throw new PairingApiError(
                "invalid_relay_response",
                "The relay returned an invalid additional Session workspace.",
            );
        }
        directoryIds.push(directoryId);
    }
    if (new Set(directoryIds).size !== directoryIds.length) {
        throw new PairingApiError(
            "invalid_relay_response",
            "The relay returned duplicate additional Session workspaces.",
        );
    }
    return directoryIds;
}

function readSessionAdditionalDirectoryIds(messages: readonly unknown[]): readonly string[] {
    const first = messages[0];
    if (first === undefined) {
        return [];
    }
    if (!isRecord(first)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid session message.");
    }
    const recorded = readAdditionalDirectoryIds(first["additionalDirectoryIds"]);
    for (const message of messages.slice(1)) {
        if (!isRecord(message)) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid session message.");
        }
        const directoryIds = readAdditionalDirectoryIds(message["additionalDirectoryIds"]);
        if (
            recorded.length !== directoryIds.length ||
            recorded.some((directoryId, index) => directoryId !== directoryIds[index])
        ) {
            throw new PairingApiError(
                "invalid_relay_response",
                "The relay returned inconsistent additional Session workspaces.",
            );
        }
    }
    return recorded;
}

function readAllowedString(value: unknown, field: string, allowedValues: ReadonlySet<string>): string {
    const text = readText(value, field, 64);
    if (!allowedValues.has(text)) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return text;
}

function decodeRecordedActivity(value: unknown): RecordedActivity {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid agent activity.");
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
        throw new PairingApiError("invalid_relay_response", "The relay returned invalid agent activity details.");
    }
    const content = contentValue.map((entry) => decodeAgentDisplayContentValue(entry));
    const detailAvailability = value["detailAvailability"];
    if (
        detailAvailability !== "available" &&
        detailAvailability !== "truncated" &&
        detailAvailability !== "unrecorded"
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned invalid activity detail availability.");
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
        readIdentifier(value["attemptId"], "agent activity Attempt"),
        readAllowedString(value["activityType"], "agent activity type", ACTIVITY_TYPES),
        readText(value["input"], "agent activity input", 24_000),
        locations,
        readText(value["name"], "agent activity name", 128),
        readText(value["output"], "agent activity output", 24_000),
        sequence,
        readAllowedString(value["status"], "agent activity status", ACTIVITY_STATUSES),
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
        throw new PairingApiError("invalid_relay_response", "The relay returned invalid agent content.");
    }
    const contents: RecordedContent[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (!isRecord(candidate)) {
            throw new PairingApiError("invalid_relay_response", "The relay returned invalid agent content.");
        }
        const contentId = readIdentifier(candidate["contentId"], "agent content identifier");
        if (identifiers.has(contentId)) {
            throw new PairingApiError("invalid_relay_response", "The relay returned duplicate agent content.");
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
        throw new PairingApiError("invalid_relay_response", "The relay returned invalid agent activities.");
    }
    const activities: RecordedActivity[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        const activity = decodeRecordedActivity(candidate);
        if (identifiers.has(activity.activityId)) {
            throw new PairingApiError("invalid_relay_response", "The relay returned a duplicate agent activity.");
        }
        identifiers.add(activity.activityId);
        activities.push(activity);
    }
    activities.sort((left, right) => left.sequence - right.sequence);
    return activities;
}

function decodeAgents(value: unknown): readonly AgentOption[] {
    if (!Array.isArray(value) || value.length > 8) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid agent directory.");
    }
    const agents: AgentOption[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            Object.keys(candidate).length !== 4 ||
            !Object.hasOwn(candidate, "agentPath") ||
            !Object.hasOwn(candidate, "agentVersion") ||
            !Object.hasOwn(candidate, "id") ||
            !Object.hasOwn(candidate, "label")
        ) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid agent directory.");
        }
        const id = candidate["id"];
        const label = candidate["label"];
        const agentPath = candidate["agentPath"];
        const agentVersion = candidate["agentVersion"];
        if (
            typeof agentPath !== "string" ||
            agentPath.trim().length === 0 ||
            agentPath.length > 4_096 ||
            typeof agentVersion !== "string" ||
            agentVersion.trim().length === 0 ||
            agentVersion.length > 128 ||
            typeof id !== "string" ||
            !isIdentifier(id) ||
            identifiers.has(id) ||
            typeof label !== "string" ||
            label.trim().length === 0 ||
            label.length > 80
        ) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid agent directory.");
        }
        identifiers.add(id);
        agents.push(new AgentOption(id, label.trim(), agentPath, agentVersion.trim()));
    }
    return agents;
}

function decodeInstallableAgents(value: unknown): readonly InstallableAgentOption[] {
    if (!Array.isArray(value) || value.length > 8) {
        throw new PairingApiError(
            "invalid_relay_response",
            "The relay returned an invalid installable Agent directory.",
        );
    }
    const agents: InstallableAgentOption[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (!isRecord(candidate)) {
            throw new PairingApiError(
                "invalid_relay_response",
                "The relay returned an invalid installable Agent directory.",
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
                "The relay returned an invalid installable Agent directory.",
            );
        }
        identifiers.add(id);
        const status = candidate["status"];
        if (
            status === "agent_not_installed" &&
            Object.keys(candidate).length === 3 &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label") &&
            Object.hasOwn(candidate, "status")
        ) {
            agents.push(new MissingAgentOption(id, label.trim()));
            continue;
        }
        if (
            status === "integration_not_installed" &&
            Object.keys(candidate).length === 5 &&
            Object.hasOwn(candidate, "agentPath") &&
            Object.hasOwn(candidate, "agentVersion") &&
            Object.hasOwn(candidate, "id") &&
            Object.hasOwn(candidate, "label") &&
            Object.hasOwn(candidate, "status")
        ) {
            const agentPath = candidate["agentPath"];
            const agentVersion = candidate["agentVersion"];
            if (
                typeof agentPath !== "string" ||
                agentPath.trim().length === 0 ||
                agentPath.length > 4_096 ||
                typeof agentVersion !== "string" ||
                agentVersion.trim().length === 0 ||
                agentVersion.length > 128
            ) {
                throw new PairingApiError(
                    "invalid_relay_response",
                    "The relay returned an invalid installable Agent directory.",
                );
            }
            agents.push(new AgentIntegrationOption(id, label.trim(), agentPath, agentVersion.trim()));
            continue;
        }
        throw new PairingApiError(
            "invalid_relay_response",
            "The relay returned an invalid installable Agent directory.",
        );
    }
    return agents;
}

function decodeCreatedPairing(value: unknown): CreatedPairing {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid pairing request.");
    }
    const pairingId = value["pairingId"];
    const pairingCode = value["pairingCode"];
    const pollToken = value["pollToken"];
    const channelId = value["channelId"];
    const hostToken = value["hostToken"];
    const tenantId = value["tenantId"];
    const projectId = value["projectId"];
    const runtimeId = value["runtimeId"];
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
        !isIdentifier(projectId) ||
        typeof runtimeId !== "string" ||
        !isIdentifier(runtimeId)
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid pairing request.");
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
        runtimeId,
    );
}

interface BrowserChannelCredential {
    readonly hostToken: string;
    readonly projectId: string;
    readonly tenantId: string;
}

function saveBrowserChannelCredential(channelId: string, credential: BrowserChannelCredential): void {
    window.localStorage.setItem(
        `${CHANNEL_CREDENTIAL_PREFIX}${channelId}`,
        JSON.stringify({
            hostToken: credential.hostToken,
            projectId: credential.projectId,
            tenantId: credential.tenantId,
        }),
    );
}

function saveChannelCredential(pairing: CreatedPairing): void {
    saveBrowserChannelCredential(pairing.channelId, {
        hostToken: pairing.hostToken,
        projectId: pairing.projectId,
        tenantId: pairing.tenantId,
    });
}

function readChannelCredential(channelId: string): BrowserChannelCredential {
    let value: unknown;
    try {
        const encoded = window.localStorage.getItem(`${CHANNEL_CREDENTIAL_PREFIX}${channelId}`);
        value = encoded === null ? null : JSON.parse(encoded);
    } catch (cause) {
        throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.", { cause });
    }
    if (!isRecord(value)) {
        throw new PairingApiError("channel_credential_missing", "This browser does not have access to the channel.");
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
        throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
    }
    return { hostToken, projectId, tenantId };
}

function decodeCreatedChannelAccessGrant(value: unknown): CreatedChannelAccessGrant {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid access link.");
    }
    const grantId = value["grantId"];
    const grantSecret = value["grantSecret"];
    if (
        typeof grantId !== "string" ||
        !isIdentifier(grantId) ||
        typeof grantSecret !== "string" ||
        !isToken(grantSecret)
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid access link.");
    }
    return new CreatedChannelAccessGrant(grantId, grantSecret, readDate(value["expiresAt"], "access link expiry time"));
}

function decodeLinkedChannelDevices(value: unknown): readonly LinkedChannelDevice[] {
    if (!isRecord(value) || !Array.isArray(value["devices"])) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid linked device list.");
    }
    const devices: LinkedChannelDevice[] = [];
    const credentialIds = new Set<string>();
    for (const candidate of value["devices"]) {
        if (!isRecord(candidate)) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid linked device.");
        }
        const credentialId = candidate["credentialId"];
        if (typeof credentialId !== "string" || !isIdentifier(credentialId) || credentialIds.has(credentialId)) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid linked device.");
        }
        credentialIds.add(credentialId);
        devices.push(
            new LinkedChannelDevice(
                credentialId,
                readDate(candidate["createdAt"], "linked device creation time"),
                readDate(candidate["lastUsedAt"], "linked device activity time"),
            ),
        );
    }
    return devices;
}

function decodeRedeemedChannelCredential(value: unknown, expectedChannelId: string): BrowserChannelCredential {
    if (!isRecord(value) || value["channelId"] !== expectedChannelId) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel credential.");
    }
    const hostToken = value["hostToken"];
    const projectId = value["projectId"];
    const tenantId = value["tenantId"];
    if (
        typeof hostToken !== "string" ||
        !isToken(hostToken) ||
        typeof projectId !== "string" ||
        !isIdentifier(projectId) ||
        typeof tenantId !== "string" ||
        !isIdentifier(tenantId)
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel credential.");
    }
    return { hostToken, projectId, tenantId };
}

abstract class ChannelAccessFragmentState {}

class MissingChannelAccessFragment extends ChannelAccessFragmentState {}

class PresentChannelAccessFragment extends ChannelAccessFragmentState {
    readonly grantId: string;
    readonly grantSecret: string;

    constructor(grantId: string, grantSecret: string) {
        super();
        this.grantId = grantId;
        this.grantSecret = grantSecret;
    }
}

function readChannelAccessFragment(): ChannelAccessFragmentState {
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    const accessValues = parameters.getAll("access");
    if (accessValues.length === 0) {
        return new MissingChannelAccessFragment();
    }
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    if (accessValues.length !== 1 || Array.from(parameters.keys()).length !== 1) {
        throw new PairingApiError("access_link_invalid", "The access link is malformed.");
    }
    const access = accessValues[0] ?? "";
    const separator = access.indexOf(".");
    if (separator <= 0 || separator !== access.lastIndexOf(".") || separator === access.length - 1) {
        throw new PairingApiError("access_link_invalid", "The access link is malformed.");
    }
    const grantId = access.slice(0, separator);
    const grantSecret = access.slice(separator + 1);
    if (!isIdentifier(grantId) || !isToken(grantSecret)) {
        throw new PairingApiError("access_link_invalid", "The access link is malformed.");
    }
    return new PresentChannelAccessFragment(grantId, grantSecret);
}

async function hasUsableChannelCredential(channelId: string, cancellationSignal: AbortSignal): Promise<boolean> {
    let credential: BrowserChannelCredential;
    try {
        credential = readChannelCredential(channelId);
    } catch (error) {
        if (
            error instanceof PairingApiError &&
            (error.code === "channel_credential_missing" || error.code === "channel_credential_invalid")
        ) {
            return false;
        }
        throw error;
    }
    const endpoint = mobiusApiUrl(window.location.origin, `/channels/${encodeURIComponent(channelId)}`);
    try {
        await requestJson(
            endpoint,
            {
                headers: { authorization: `Bearer ${credential.hostToken}` },
                method: "GET",
            },
            requestSignal(cancellationSignal),
        );
        return true;
    } catch (error) {
        if (error instanceof PairingApiError && error.code === "unauthorized") {
            return false;
        }
        throw error;
    }
}

function requestSignal(cancellationSignal: AbortSignal): AbortSignal {
    return AbortSignal.any([cancellationSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]);
}

function decodeChannelConnection(
    value: unknown,
    expectedChannelId: string,
    credential: BrowserChannelCredential,
): ChannelConnection {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel.");
    }
    const channelId = value["channelId"];
    const runtimeId = value["runtimeId"];
    if (
        typeof channelId !== "string" ||
        !isIdentifier(channelId) ||
        channelId !== expectedChannelId ||
        typeof runtimeId !== "string" ||
        !isIdentifier(runtimeId)
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel.");
    }
    if (value["tenantId"] !== credential.tenantId || value["projectId"] !== credential.projectId) {
        throw new PairingApiError("invalid_relay_response", "The relay returned a channel from another project.");
    }
    const agents = decodeAgents(value["agents"]);
    const installableAgents = decodeInstallableAgents(value["installableAgents"]);
    if (
        agents.length + installableAgents.length === 0 ||
        installableAgents.some((agent) => agents.some((available) => available.id === agent.id))
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid Agent catalog.");
    }
    return new ChannelConnection(
        agents,
        channelId,
        readString(value["machineName"], "machine name", 120),
        readString(value["workspaceName"], "workspace name", 120),
        credential.hostToken,
        credential.tenantId,
        credential.projectId,
        runtimeId,
        installableAgents,
    );
}

function decodeRecordedTurn(value: unknown): RecordedTurn {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid conversation history.");
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
            readIdentifier(value["attemptId"], "history attempt"),
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
            readIdentifier(value["attemptId"], "history attempt"),
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
    throw new PairingApiError("invalid_relay_response", "The relay returned an invalid conversation history state.");
}

export async function createBrowserPairing(): Promise<CreatedPairing> {
    const pairing = decodeCreatedPairing(
        await requestJson(mobiusApiUrl(window.location.origin, "/pairings"), {
            method: "POST",
        }),
    );
    saveChannelCredential(pairing);
    return pairing;
}

export async function readBrowserPairingStatus(pairing: CreatedPairing): Promise<BrowserPairingStatus> {
    const endpoint = mobiusApiUrl(window.location.origin, `/pairings/${encodeURIComponent(pairing.pairingId)}`);
    endpoint.searchParams.set("token", pairing.pollToken);
    const value = await requestJson(endpoint, { method: "GET" });
    if (!isRecord(value) || typeof value["status"] !== "string") {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid pairing status.");
    }
    if (value["status"] === "pending") {
        return new WaitingBrowserPairingStatus(readDate(value["expiresAt"], "expiry time"));
    }
    if (value["status"] === "expired") {
        return new ExpiredBrowserPairingStatus();
    }
    if (value["status"] !== "paired") {
        throw new PairingApiError("invalid_relay_response", "The relay returned an unknown pairing status.");
    }
    return new ConnectedBrowserPairingStatus(
        decodeChannelConnection(value, pairing.channelId, {
            hostToken: pairing.hostToken,
            projectId: pairing.projectId,
            tenantId: pairing.tenantId,
        }),
    );
}

export async function createChannelAccessGrant(
    channelId: string,
    cancellationSignal: AbortSignal,
): Promise<CreatedChannelAccessGrant> {
    const credential = readChannelCredential(channelId);
    const endpoint = mobiusApiUrl(window.location.origin, `/channels/${encodeURIComponent(channelId)}/access-grants`);
    return decodeCreatedChannelAccessGrant(
        await requestJson(
            endpoint,
            {
                headers: { authorization: `Bearer ${credential.hostToken}` },
                method: "POST",
            },
            requestSignal(cancellationSignal),
        ),
    );
}

export async function readLinkedChannelDevices(
    channelId: string,
    cancellationSignal: AbortSignal,
): Promise<readonly LinkedChannelDevice[]> {
    const credential = readChannelCredential(channelId);
    const endpoint = mobiusApiUrl(window.location.origin, `/channels/${encodeURIComponent(channelId)}/linked-devices`);
    return decodeLinkedChannelDevices(
        await requestJson(
            endpoint,
            {
                headers: { authorization: `Bearer ${credential.hostToken}` },
                method: "GET",
            },
            requestSignal(cancellationSignal),
        ),
    );
}

export async function redeemChannelAccessGrantFromLocation(
    channelId: string,
    cancellationSignal: AbortSignal,
): Promise<void> {
    const fragment = readChannelAccessFragment();
    if (fragment instanceof MissingChannelAccessFragment) {
        return;
    }
    if (!(fragment instanceof PresentChannelAccessFragment)) {
        throw new PairingApiError("access_link_invalid", "The access link is malformed.");
    }
    if (await hasUsableChannelCredential(channelId, cancellationSignal)) {
        return;
    }
    const endpoint = mobiusApiUrl(
        window.location.origin,
        `/channels/${encodeURIComponent(channelId)}/access-grants/${encodeURIComponent(fragment.grantId)}/redeem`,
    );
    const credential = decodeRedeemedChannelCredential(
        await requestJson(
            endpoint,
            {
                body: JSON.stringify({ grantSecret: fragment.grantSecret }),
                headers: { "content-type": "application/json" },
                method: "POST",
            },
            requestSignal(cancellationSignal),
        ),
        channelId,
    );
    try {
        saveBrowserChannelCredential(channelId, credential);
    } catch (cause) {
        throw new PairingApiError(
            "channel_credential_unavailable",
            "This browser could not save access to the channel.",
            { cause },
        );
    }
}

export async function revokeLinkedChannelDevice(
    channelId: string,
    credentialId: string,
    cancellationSignal: AbortSignal,
): Promise<void> {
    const credential = readChannelCredential(channelId);
    const endpoint = mobiusApiUrl(
        window.location.origin,
        `/channels/${encodeURIComponent(channelId)}/linked-devices/${encodeURIComponent(credentialId)}`,
    );
    await requestEmpty(
        endpoint,
        {
            headers: { authorization: `Bearer ${credential.hostToken}` },
            method: "DELETE",
        },
        requestSignal(cancellationSignal),
    );
}

export async function readChannelConnection(
    channelId: string,
    cancellationSignal: AbortSignal = new AbortController().signal,
): Promise<ChannelConnection> {
    const credential = readChannelCredential(channelId);
    const endpoint = mobiusApiUrl(window.location.origin, `/channels/${encodeURIComponent(channelId)}`);
    return decodeChannelConnection(
        await requestJson(
            endpoint,
            {
                headers: { authorization: `Bearer ${credential.hostToken}` },
                method: "GET",
            },
            requestSignal(cancellationSignal),
        ),
        channelId,
        credential,
    );
}

export async function readChannelHistory(channelId: string): Promise<ChannelHistory> {
    return await readChannelHistoryWithSignal(channelId, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS));
}

interface PendingSessionInteractions {
    readonly elicitations: readonly SessionElicitationRequestedEvent[];
    readonly permissions: readonly SessionPermissionRequestedEvent[];
}

function isAcceptedUrlResponse(interaction: Interaction): boolean {
    if (
        interaction.request.kind !== "elicitation" ||
        interaction.request.mode !== "url" ||
        interaction.state.kind !== "responded" ||
        interaction.state.response.kind !== "elicitation"
    ) {
        return false;
    }
    try {
        const response: unknown = JSON.parse(interaction.state.response.content);
        return (
            isRecord(response) &&
            Object.keys(response).length === 2 &&
            response["action"] === "accept" &&
            typeof response["content"] === "string"
        );
    } catch {
        return false;
    }
}

function decodePendingSessionInteractions(
    value: unknown,
    sessionId: string,
    turns: readonly RecordedTurn[],
): PendingSessionInteractions {
    if (
        !isRecord(value) ||
        Object.keys(value).length !== 1 ||
        !Array.isArray(value["interactions"]) ||
        value["interactions"].length > 100
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid pending Interaction page.");
    }
    const commandIdsByAttempt = new Map(
        turns.filter((turn) => turn instanceof RunningRecordedTurn).map((turn) => [turn.attemptId, turn.commandId]),
    );
    const elicitations: SessionElicitationRequestedEvent[] = [];
    const permissions: SessionPermissionRequestedEvent[] = [];
    for (const candidate of value["interactions"]) {
        let interaction: Interaction;
        try {
            interaction = decodeInteraction(candidate);
        } catch (cause) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid pending Interaction.", {
                cause,
            });
        }
        if (
            interaction.sessionId !== sessionId ||
            (interaction.state.kind !== "pending" && interaction.state.kind !== "responded")
        ) {
            throw new PairingApiError(
                "invalid_relay_response",
                "The relay returned an inconsistent pending Interaction.",
            );
        }
        const commandId = commandIdsByAttempt.get(interaction.attemptId);
        if (commandId === undefined) {
            continue;
        }
        if (interaction.request.kind === "permission") {
            if (interaction.state.kind === "pending") {
                permissions.push({
                    commandId,
                    interactionId: interaction.interactionId,
                    kind: "session.permission.requested",
                    options: interaction.request.options,
                    sessionId,
                    title: interaction.request.title,
                    toolCallId: interaction.request.toolCallId,
                    toolKind: interaction.request.toolKind,
                });
            }
            continue;
        }
        if (interaction.state.kind === "pending" || isAcceptedUrlResponse(interaction)) {
            elicitations.push({
                accepted: interaction.state.kind === "responded",
                commandId,
                elicitationId: interaction.request.elicitationId,
                fields: interaction.request.fields,
                interactionId: interaction.interactionId,
                kind: "session.elicitation.requested",
                message: interaction.request.message,
                mode: interaction.request.mode,
                sessionId,
                url: interaction.request.url,
            });
        }
    }
    return { elicitations, permissions };
}

interface RestoredChannelSession {
    readonly session: RecordedSession;
    readonly turns: RecordedTurn[];
}

function isConcurrentSessionRemoval(error: unknown): boolean {
    return error instanceof PairingApiError && (error.code === "session_not_found" || error.code === "session_deleted");
}

async function readChannelHistoryWithSignal(channelId: string, signal: AbortSignal): Promise<ChannelHistory> {
    const credential = readChannelCredential(channelId);
    const headers = { authorization: `Bearer ${credential.hostToken}` };
    const directoryEndpoint = mobiusApiUrl(
        window.location.origin,
        `/projects/${encodeURIComponent(credential.projectId)}/sessions`,
    );
    directoryEndpoint.searchParams.set("limit", "100");
    const directory = await requestJson(directoryEndpoint, { headers, method: "GET" }, signal);
    if (!isRecord(directory) || !Array.isArray(directory["sessions"])) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid session directory.");
    }
    const summaries = directory["sessions"].map((session) => decodeRecordedSession(session, credential));
    const restoredBySessionId = new Map<string, RestoredChannelSession>();
    await Promise.all(
        summaries.map(async ({ hasNativeHistory, session }) => {
            try {
                const messagesEndpoint = mobiusApiUrl(
                    window.location.origin,
                    `/projects/${encodeURIComponent(credential.projectId)}/sessions/${encodeURIComponent(session.sessionId)}/messages`,
                );
                messagesEndpoint.searchParams.set("limit", "100");
                const historyEndpoint = mobiusApiUrl(
                    window.location.origin,
                    `/projects/${encodeURIComponent(credential.projectId)}/sessions/${encodeURIComponent(session.sessionId)}/native-history`,
                );
                const interactionsEndpoint = mobiusApiUrl(
                    window.location.origin,
                    `/projects/${encodeURIComponent(credential.projectId)}/sessions/${encodeURIComponent(session.sessionId)}/interactions`,
                );
                const [page, nativeHistoryValue, interactionPage] = await Promise.all([
                    requestJson(messagesEndpoint, { headers, method: "GET" }, signal),
                    hasNativeHistory
                        ? requestJson(historyEndpoint, { headers, method: "GET" }, signal)
                        : Promise.resolve(null),
                    requestJson(interactionsEndpoint, { headers, method: "GET" }, signal),
                ]);
                if (!isRecord(page) || !Array.isArray(page["messages"])) {
                    throw new PairingApiError("invalid_relay_response", "The relay returned an invalid message page.");
                }
                const lastCommittedSeq = readCommittedSequence(page["lastCommittedSeq"], "message page sequence");
                const additionalDirectoryIds = readSessionAdditionalDirectoryIds(page["messages"]);
                const turns = page["messages"].map(decodeSessionMessage);
                const interactions = decodePendingSessionInteractions(interactionPage, session.sessionId, turns);
                restoredBySessionId.set(session.sessionId, {
                    turns,
                    session: new RecordedSession(
                        session.agentId,
                        session.bindingId,
                        session.configRevision,
                        session.directoryId,
                        session.runtimeId,
                        session.sessionId,
                        session.title,
                        session.updatedAt,
                        nativeHistoryValue === null ? null : decodeNativeSessionHistory(nativeHistoryValue),
                        interactions.elicitations,
                        interactions.permissions,
                        additionalDirectoryIds,
                        lastCommittedSeq,
                    ),
                });
            } catch (error) {
                if (!isConcurrentSessionRemoval(error)) {
                    throw error;
                }
            }
        }),
    );
    const restored: RestoredChannelSession[] = [];
    for (const { session } of summaries) {
        const value = restoredBySessionId.get(session.sessionId);
        if (value !== undefined) {
            restored.push(value);
        }
    }
    const sessions = restored.map(({ session }) => session);
    const turns: RecordedTurn[] = [];
    for (const { turns: sessionTurns } of restored) {
        sessionTurns.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
        turns.push(...sessionTurns);
    }
    return new ChannelHistory(turns, sessions);
}

function decodeRecordedSession(
    value: unknown,
    credential: BrowserChannelCredential,
): { readonly hasNativeHistory: boolean; readonly session: RecordedSession } {
    if (!isRecord(value) || !isRecord(value["defaultBinding"]) || !isRecord(value["lifecycle"])) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid session summary.");
    }
    const sessionId = readIdentifier(value["sessionId"], "session identifier");
    const agentId = readIdentifier(value["agentId"], "session Agent");
    const runtimeId = readIdentifier(value["runtimeId"], "session Runtime");
    const binding = value["defaultBinding"];
    const configRevision = binding["configRevision"];
    const hasNativeHistory = value["hasNativeHistory"];
    if (
        value["tenantId"] !== credential.tenantId ||
        value["projectId"] !== credential.projectId ||
        value["lifecycle"]["kind"] !== "ready" ||
        binding["sessionId"] !== sessionId ||
        binding["agentRef"] !== agentId ||
        binding["runtimeId"] !== runtimeId ||
        typeof configRevision !== "number" ||
        !Number.isSafeInteger(configRevision) ||
        configRevision < 0 ||
        typeof hasNativeHistory !== "boolean"
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an inconsistent session summary.");
    }
    return {
        hasNativeHistory,
        session: new RecordedSession(
            agentId,
            readIdentifier(binding["bindingId"], "Session binding"),
            configRevision,
            readIdentifier(binding["workspaceRef"], "Session workspace"),
            runtimeId,
            sessionId,
            readText(value["title"], "session title", 500),
            readDate(value["updatedAt"], "session update time").toISOString(),
            null,
            [],
            [],
            [],
            readCommittedSequence(value["lastCommittedSeq"], "session sequence"),
        ),
    };
}

function decodeSessionMessage(value: unknown): RecordedTurn {
    if (!isRecord(value) || !Array.isArray(value["activities"])) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid session message.");
    }
    const base = {
        activities: value["activities"],
        agentId: value["agentId"],
        commandId: value["commandId"],
        contents: [],
        createdAt: value["createdAt"],
        images: value["images"],
        prompt: value["prompt"],
        resources: value["resources"],
        response: value["response"],
        sessionId: value["sessionId"],
    };
    const attempt = value["attempt"];
    if (attempt === null) {
        return decodeRecordedTurn({ ...base, status: "pending" });
    }
    if (!isRecord(attempt) || typeof attempt["kind"] !== "string") {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid execution attempt.");
    }
    if (attempt["kind"] === "dispatching" || attempt["kind"] === "running" || attempt["kind"] === "waiting_input") {
        return decodeRecordedTurn({
            ...base,
            attemptId: attempt["attemptId"],
            status: "running",
        });
    }
    if (attempt["kind"] === "succeeded") {
        return decodeRecordedTurn({
            ...base,
            attemptId: attempt["attemptId"],
            status: "completed",
            stopReason: attempt["stopReason"],
        });
    }
    if (attempt["kind"] === "cancelled") {
        return decodeRecordedTurn({
            ...base,
            attemptId: attempt["attemptId"],
            status: "completed",
            stopReason: "cancelled",
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
    if (attempt["kind"] === "indeterminate") {
        return decodeRecordedTurn({
            ...base,
            code: "indeterminate",
            message: "The runtime disconnected before the execution outcome was reconciled.",
            status: "failed",
        });
    }
    throw new PairingApiError("invalid_relay_response", "The relay returned an unknown execution attempt state.");
}

function decodeActivityDetail(value: unknown): ActivityDetailResult {
    if (!isRecord(value)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned invalid activity details.");
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
            throw new PairingApiError("invalid_relay_response", "The relay returned invalid truncation details.");
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
        throw new PairingApiError("invalid_relay_response", "The relay returned invalid activity details.");
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

export async function readToolCallDetail(
    channelId: string,
    sessionId: string,
    attemptId: string,
    toolCallId: string,
    signal: AbortSignal,
): Promise<ActivityDetailResult> {
    const credential = readChannelCredential(channelId);
    const endpoint = mobiusApiUrl(
        window.location.origin,
        `/projects/${encodeURIComponent(credential.projectId)}/sessions/${encodeURIComponent(sessionId)}/attempts/${encodeURIComponent(attemptId)}/tool-calls/${encodeURIComponent(toolCallId)}`,
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
        AbortSignal.any([cancellationSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]),
    );
}

export function pairingCommand(pairing: CreatedPairing): string {
    return `npx --yes @moxt-ai/mobius pair --url ${JSON.stringify(window.location.origin)} --code ${pairing.pairingCode}`;
}
