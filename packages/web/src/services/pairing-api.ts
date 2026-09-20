import {
    AGENT_ACTIVITY_DETAIL_LIMIT,
    decodeAgentDisplayContentValue,
    decodeMobiusAgentCapabilities,
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeRecordedAgentContentValue,
    type Interaction,
    MAX_LOCAL_AGENT_DIRECTORY_ENTRIES,
    MobiusAgentIntegrationDescriptor,
    MobiusClient,
    MobiusError,
    MobiusMissingAgentDescriptor,
    MobiusPageRequest,
    type MobiusRuntimeDescriptor,
    type MobiusRuntimePairing,
    MobiusRuntimePairingRequest,
    type MobiusRuntimePairingStatus,
    type MobiusSession,
    mobiusApiUrl,
    type SessionElicitationRequestedEvent,
    type SessionPermissionRequestedEvent,
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";

import {
    AgentIntegrationOption,
    AgentOption,
    type BrowserPairingStatus,
    ChannelConnection,
    type ChannelCredentialAuthority,
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
    LegacyChannelCredentialAuthority,
    LinkedChannelCredentialAuthority,
    LinkedChannelDevice,
    MissingAgentOption,
    OwnerChannelCredentialAuthority,
    PairingApiError,
    PendingRecordedTurn,
    ProjectRuntimeCredentialAuthority,
    RecordedActivity,
    RecordedContent,
    RecordedSession,
    type RecordedTurn,
    RunningRecordedTurn,
    type TurnTiming,
    UNTIMED_TURN,
    WaitingBrowserPairingStatus,
} from "@/domain/channel";

const REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const CHANNEL_CREDENTIAL_PREFIX = "mobius:channel-credential:";
const PROJECT_OWNER_CREDENTIAL_PREFIX = "mobius:project-owner-credential:";
const DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
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
        readText(value["input"], "agent activity input", AGENT_ACTIVITY_DETAIL_LIMIT),
        locations,
        readText(value["name"], "agent activity name", 128),
        readText(value["output"], "agent activity output", AGENT_ACTIVITY_DETAIL_LIMIT),
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
        let activity: RecordedActivity;
        try {
            activity = decodeRecordedActivity(candidate);
        } catch {
            // A step the current protocol revision cannot read must cost only that step. Failing here
            // would turn one unreadable record into an unavailable Session.
            continue;
        }
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
    if (!Array.isArray(value) || value.length > MAX_LOCAL_AGENT_DIRECTORY_ENTRIES) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid agent directory.");
    }
    const agents: AgentOption[] = [];
    const identifiers = new Set<string>();
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            Object.keys(candidate).length < 5 ||
            Object.keys(candidate).length > 8 ||
            !Object.hasOwn(candidate, "agentPath") ||
            !Object.hasOwn(candidate, "agentVersion") ||
            !Object.hasOwn(candidate, "capabilities") ||
            !Object.hasOwn(candidate, "id") ||
            !Object.hasOwn(candidate, "label") ||
            Object.keys(candidate).some(
                (key) =>
                    key !== "agentPath" &&
                    key !== "agentVersion" &&
                    key !== "agentSettingsDiscovery" &&
                    key !== "capabilities" &&
                    key !== "id" &&
                    key !== "label" &&
                    key !== "sessionTurnConfiguration",
            ) ||
            (Object.hasOwn(candidate, "agentSettingsDiscovery") &&
                typeof candidate["agentSettingsDiscovery"] !== "boolean") ||
            (Object.hasOwn(candidate, "sessionTurnConfiguration") &&
                typeof candidate["sessionTurnConfiguration"] !== "boolean")
        ) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid agent directory.");
        }
        const capabilities = decodeMobiusAgentCapabilities(candidate["capabilities"]);
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
        agents.push(
            new AgentOption(
                id,
                label.trim(),
                agentPath,
                agentVersion.trim(),
                capabilities,
                candidate["agentSettingsDiscovery"] === true,
                candidate["sessionTurnConfiguration"] === true,
            ),
        );
    }
    return agents;
}

function decodeInstallableAgents(value: unknown): readonly InstallableAgentOption[] {
    if (!Array.isArray(value) || value.length > MAX_LOCAL_AGENT_DIRECTORY_ENTRIES) {
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
        projectId,
        runtimeId,
    );
}

abstract class BrowserChannelCredential {
    abstract readonly authority: string;
    readonly hostToken: string;
    readonly projectId: string;

    constructor(hostToken: string, projectId: string) {
        this.hostToken = hostToken;
        this.projectId = projectId;
    }
}

class OwnerBrowserChannelCredential extends BrowserChannelCredential {
    readonly authority = "owner";
}

class LinkedBrowserChannelCredential extends BrowserChannelCredential {
    readonly authority = "linked";
}

class LegacyBrowserChannelCredential extends BrowserChannelCredential {
    readonly authority = "legacy";
}

class ProjectOwnerBrowserCredential extends BrowserChannelCredential {
    readonly authority = "project-owner";
    readonly ownerChannelId: string;

    constructor(hostToken: string, projectId: string, ownerChannelId: string) {
        super(hostToken, projectId);
        this.ownerChannelId = ownerChannelId;
    }
}

/**
 * A Project Runtime connection addresses one Runtime rather than the channel that opened it. It carries the
 * host socket through the Project Runtime route, so a linked browser never needs a credential alias for
 * another machine's channel.
 */
function connectionCredentialAuthority(
    credential: BrowserChannelCredential,
    accessChannelId: string,
): ChannelCredentialAuthority {
    if (credential instanceof ProjectOwnerBrowserCredential || credential instanceof LinkedBrowserChannelCredential) {
        return new ProjectRuntimeCredentialAuthority(accessChannelId);
    }
    return channelCredentialAuthority(credential);
}

function channelCredentialAuthority(credential: BrowserChannelCredential): ChannelCredentialAuthority {
    if (credential instanceof OwnerBrowserChannelCredential) {
        return new OwnerChannelCredentialAuthority();
    }
    if (credential instanceof LinkedBrowserChannelCredential) {
        return new LinkedChannelCredentialAuthority();
    }
    if (credential instanceof LegacyBrowserChannelCredential) {
        return new LegacyChannelCredentialAuthority();
    }
    throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
}

export abstract class RuntimeManagementAccess {}

export class OwnerRuntimeManagementAccess extends RuntimeManagementAccess {}

class ReadOnlyRuntimeManagementAccess extends RuntimeManagementAccess {}

function saveBrowserChannelCredential(channelId: string, credential: BrowserChannelCredential): void {
    window.localStorage.setItem(
        `${CHANNEL_CREDENTIAL_PREFIX}${channelId}`,
        JSON.stringify({
            authority: credential.authority,
            hostToken: credential.hostToken,
            projectId: credential.projectId,
        }),
    );
}

function saveChannelCredential(pairing: CreatedPairing): void {
    const credential = new OwnerBrowserChannelCredential(pairing.hostToken, pairing.projectId);
    saveBrowserChannelCredential(pairing.channelId, credential);
    saveProjectOwnerCredential(pairing.channelId, credential);
}

function saveProjectOwnerCredential(ownerChannelId: string, credential: BrowserChannelCredential): void {
    window.localStorage.setItem(
        `${PROJECT_OWNER_CREDENTIAL_PREFIX}${credential.projectId}`,
        JSON.stringify({
            hostToken: credential.hostToken,
            ownerChannelId,
            projectId: credential.projectId,
        }),
    );
}

function readProjectOwnerCredential(projectId: string): ProjectOwnerBrowserCredential {
    let value: unknown;
    try {
        const encoded = window.localStorage.getItem(`${PROJECT_OWNER_CREDENTIAL_PREFIX}${projectId}`);
        value = encoded === null ? null : JSON.parse(encoded);
    } catch (cause) {
        throw new PairingApiError(
            "project_owner_credential_invalid",
            "The saved Project owner credential is invalid.",
            {
                cause,
            },
        );
    }
    if (!isRecord(value)) {
        throw new PairingApiError(
            "project_owner_credential_missing",
            "This browser does not have owner access to the Project.",
        );
    }
    const hostToken = value["hostToken"];
    const ownerChannelId = value["ownerChannelId"];
    const storedProjectId = value["projectId"];
    if (
        typeof hostToken !== "string" ||
        !isToken(hostToken) ||
        typeof ownerChannelId !== "string" ||
        !isIdentifier(ownerChannelId) ||
        storedProjectId !== projectId
    ) {
        throw new PairingApiError("project_owner_credential_invalid", "The saved Project owner credential is invalid.");
    }
    return new ProjectOwnerBrowserCredential(hostToken, projectId, ownerChannelId);
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
    const projectId = value["projectId"];
    const authority = value["authority"];
    if (
        typeof hostToken !== "string" ||
        !isToken(hostToken) ||
        typeof projectId !== "string" ||
        !isIdentifier(projectId)
    ) {
        throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
    }
    if (authority === "owner") {
        return new OwnerBrowserChannelCredential(hostToken, projectId);
    }
    if (authority === "linked") {
        return new LinkedBrowserChannelCredential(hostToken, projectId);
    }
    if (authority === undefined) {
        return new LegacyBrowserChannelCredential(hostToken, projectId);
    }
    throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
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
    if (
        typeof hostToken !== "string" ||
        !isToken(hostToken) ||
        typeof projectId !== "string" ||
        !isIdentifier(projectId)
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel credential.");
    }
    return new LinkedBrowserChannelCredential(hostToken, projectId);
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
    if (value["projectId"] !== credential.projectId) {
        throw new PairingApiError("invalid_relay_response", "The relay returned a channel from another project.");
    }
    const agents = decodeAgents(value["agents"]);
    const installableAgents = decodeInstallableAgents(value["installableAgents"]);
    if (
        agents.length + installableAgents.length === 0 ||
        agents.length + installableAgents.length > MAX_LOCAL_AGENT_DIRECTORY_ENTRIES ||
        installableAgents.some((agent) => agents.some((available) => available.id === agent.id))
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid Agent catalog.");
    }
    return new ChannelConnection(
        agents,
        channelId,
        channelCredentialAuthority(credential),
        readString(value["machineName"], "machine name", 120),
        readString(value["workspaceName"], "workspace name", 120),
        credential.hostToken,
        credential.projectId,
        runtimeId,
        installableAgents,
    );
}

function runtimeConnection(
    runtime: MobiusRuntimeDescriptor,
    credential: BrowserChannelCredential,
    accessChannelId: string,
): ChannelConnection {
    if (runtime.projectId !== credential.projectId) {
        throw new PairingApiError("invalid_relay_response", "The relay returned a Runtime from another Project.");
    }
    if (
        !(credential instanceof ProjectOwnerBrowserCredential) &&
        !(credential instanceof LinkedBrowserChannelCredential)
    ) {
        throw new PairingApiError(
            "runtime_access_denied",
            "This browser cannot address another Runtime in the Project.",
        );
    }
    const agents = runtime.agents.map(
        (agent) =>
            new AgentOption(
                agent.id,
                agent.label,
                agent.agentPath,
                agent.agentVersion,
                agent.capabilities,
                agent.agentSettingsDiscovery,
                agent.sessionTurnConfiguration,
            ),
    );
    const installableAgents = runtime.installableAgents.map((agent): InstallableAgentOption => {
        if (agent instanceof MobiusMissingAgentDescriptor) {
            return new MissingAgentOption(agent.id, agent.label);
        }
        if (agent instanceof MobiusAgentIntegrationDescriptor) {
            return new AgentIntegrationOption(agent.id, agent.label, agent.agentPath, agent.agentVersion);
        }
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid installable Agent.");
    });
    if (
        agents.length + installableAgents.length === 0 ||
        agents.length + installableAgents.length > MAX_LOCAL_AGENT_DIRECTORY_ENTRIES ||
        installableAgents.some((agent) => agents.some((available) => available.id === agent.id))
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid Agent catalog.");
    }
    return new ChannelConnection(
        agents,
        runtime.channelId,
        connectionCredentialAuthority(credential, accessChannelId),
        runtime.machineName,
        runtime.workspaceName,
        credential.hostToken,
        credential.projectId,
        runtime.runtimeId,
        installableAgents,
        accessChannelId,
    );
}

/**
 * Derives Turn timing from relay attempt timestamps. Both readings come from the relay clock, so a
 * settled Turn is measured against its own start and an unsettled one keeps only its start.
 */
function decodeTurnTiming(startedAtValue: unknown, settledAtValue: unknown): TurnTiming {
    if (startedAtValue === undefined || startedAtValue === null) {
        return UNTIMED_TURN;
    }
    const startedAt = readDate(startedAtValue, "history attempt start");
    if (settledAtValue === undefined || settledAtValue === null) {
        return { kind: "running", startedAt };
    }
    const settledAt = readDate(settledAtValue, "history attempt outcome time");
    return {
        elapsedMilliseconds: Math.max(0, settledAt.getTime() - startedAt.getTime()),
        kind: "measured",
    };
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
    const disposition =
        value["disposition"] === undefined ? "reject" : readText(value["disposition"], "prompt disposition", 16);
    if (disposition !== "reject" && disposition !== "queue" && disposition !== "steer") {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid prompt disposition.");
    }
    const targetCommandId =
        value["targetCommandId"] === undefined ? "" : readText(value["targetCommandId"], "target command", 128);
    if (targetCommandId.length > 0 && !isIdentifier(targetCommandId)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid target command.");
    }
    const turnId = value["turnId"] === undefined ? "" : readText(value["turnId"], "turn", 128);
    if (turnId.length > 0 && !isIdentifier(turnId)) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid turn identifier.");
    }
    const timing = decodeTurnTiming(value["startedAt"], value["settledAt"]);
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
            disposition,
            targetCommandId,
            turnId,
            timing,
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
            disposition,
            targetCommandId,
            turnId,
            timing,
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
            disposition,
            targetCommandId,
            turnId,
            timing,
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
            disposition,
            targetCommandId,
            turnId,
            timing,
        );
    }
    throw new PairingApiError("invalid_relay_response", "The relay returned an invalid conversation history state.");
}

export async function createBrowserPairing(signal: AbortSignal, token: string | null): Promise<CreatedPairing> {
    const pairing = decodeCreatedPairing(
        await requestJson(
            mobiusApiUrl(window.location.origin, "/pairings"),
            {
                method: "POST",
                headers: token === null ? {} : { Authorization: `Bearer ${token}` },
            },
            requestSignal(signal),
        ),
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
        decodeChannelConnection(
            value,
            pairing.channelId,
            new OwnerBrowserChannelCredential(pairing.hostToken, pairing.projectId),
        ),
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

/**
 * Lists the linked devices of the channel that opened the current page. A Project Runtime route records its
 * access channel rather than the Runtime's own channel, which the browser may not hold a credential for.
 */
export async function readAccessChannelDevices(
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

export async function readProjectRuntimeConnection(
    projectId: string,
    runtimeId: string,
    cancellationSignal: AbortSignal = new AbortController().signal,
    requestedAccessChannelId: string = "",
): Promise<ChannelConnection> {
    const credential = projectCredential(requestedAccessChannelId, projectId);
    // The channel that owns device access is a property of the resolved credential, not of the
    // navigation state: a reload or deep link drops `location.state`, and an empty channel would
    // render an access link that matches no channel.
    const accessChannelId = resolveAccessChannelId(credential, requestedAccessChannelId);
    const client = publicServiceClient(credential);
    try {
        const runtimes = await client.runtimes.list(requestSignal(cancellationSignal));
        const runtime = runtimes.find((candidate) => candidate.runtimeId === runtimeId);
        if (runtime === undefined) {
            throw new PairingApiError("runtime_not_found", "The selected Runtime is not available in this Project.");
        }
        return runtimeConnection(runtime, credential, accessChannelId);
    } catch (error) {
        if (error instanceof PairingApiError) {
            throw error;
        }
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

/**
 * The device-access page belongs to one channel. The Project owner credential records which channel
 * created it, so it survives a reload even when the navigation state that carried it does not.
 */
function resolveAccessChannelId(credential: BrowserChannelCredential, requestedAccessChannelId: string): string {
    if (credential instanceof ProjectOwnerBrowserCredential) {
        return credential.ownerChannelId;
    }
    return requestedAccessChannelId;
}

export async function readConnectionHistory(
    connection: ChannelConnection,
    cancellationSignal: AbortSignal = new AbortController().signal,
): Promise<ChannelHistory> {
    return await readConnectionHistoryWithSignal(connection, requestSignal(cancellationSignal));
}

export async function readConnectionDirectory(
    connection: ChannelConnection,
    cancellationSignal: AbortSignal = new AbortController().signal,
): Promise<ChannelHistory> {
    return await readConnectionDirectoryWithSignal(connection, requestSignal(cancellationSignal));
}

export async function readSessionHistory(
    connection: ChannelConnection,
    sessionId: string,
    cancellationSignal: AbortSignal = new AbortController().signal,
): Promise<ChannelHistory> {
    return await readSessionHistoryWithSignal(connection, sessionId, requestSignal(cancellationSignal));
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

function pendingSessionInteractions(
    interactions: readonly Interaction[],
    sessionId: string,
    turns: readonly RecordedTurn[],
): PendingSessionInteractions {
    const commandIdsByAttempt = new Map(
        turns.filter((turn) => turn instanceof RunningRecordedTurn).map((turn) => [turn.attemptId, turn.commandId]),
    );
    const elicitations: SessionElicitationRequestedEvent[] = [];
    const permissions: SessionPermissionRequestedEvent[] = [];
    for (const interaction of interactions) {
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

class DecodedRecordedSession {
    readonly hasNativeHistory: boolean;
    readonly session: RecordedSession;

    constructor(hasNativeHistory: boolean, session: RecordedSession) {
        this.hasNativeHistory = hasNativeHistory;
        this.session = session;
    }
}

const MOBIUS_ARTIFACT_URI_PREFIX = "mobius-artifact:";

/**
 * Reads the artifact id out of a `mobius-artifact:<id>?byteLength=…&sha256=…` link, which is how the
 * Relay references uploaded prompt attachments on a submitted Turn. Returns an empty string when the
 * URI is not an artifact reference, so callers can fall back to showing the attachment by name.
 */
export function artifactIdFromUri(uri: string): string {
    if (!uri.startsWith(MOBIUS_ARTIFACT_URI_PREFIX)) {
        return "";
    }
    const artifactId = uri.slice(MOBIUS_ARTIFACT_URI_PREFIX.length).split("?", 1)[0] ?? "";
    return artifactId.length > 0 ? artifactId : "";
}

export async function readSessionArtifactBytes(
    connection: ChannelConnection,
    sessionId: string,
    artifactId: string,
    signal: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
    const client = publicServiceClient(projectCredential(connection.channelId, connection.projectId));
    try {
        const download = await client.artifacts.download(sessionId, artifactId, signal);
        return { bytes: download.bytes, mimeType: download.artifact.mediaType };
    } finally {
        client.close();
    }
}

function publicServiceClient(credential: BrowserChannelCredential): MobiusClient {
    return new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(credential.hostToken),
        endpoint: window.location.origin,
        projectId: credential.projectId,
    });
}

function projectCredential(channelId: string, projectId: string): BrowserChannelCredential {
    try {
        return readProjectOwnerCredential(projectId);
    } catch (error) {
        if (!(error instanceof PairingApiError) || error.code !== "project_owner_credential_missing") {
            throw error;
        }
    }
    const credential = readChannelCredential(channelId);
    if (credential.projectId !== projectId) {
        throw new PairingApiError(
            "project_access_mismatch",
            "The saved channel credential belongs to another Project.",
        );
    }
    return credential;
}

function throwPublicApiFailure(error: unknown): never {
    if (error instanceof MobiusError) {
        throw new PairingApiError(error.code, error.message, { cause: error });
    }
    throw error;
}

export async function readRuntimeManagementAccess(
    channelId: string,
    projectId: string,
    cancellationSignal: AbortSignal,
): Promise<RuntimeManagementAccess> {
    const credential = projectCredential(channelId, projectId);
    if (credential instanceof ProjectOwnerBrowserCredential) {
        return new OwnerRuntimeManagementAccess();
    }
    if (credential instanceof OwnerBrowserChannelCredential) {
        saveProjectOwnerCredential(channelId, credential);
        return new OwnerRuntimeManagementAccess();
    }
    if (credential instanceof LinkedBrowserChannelCredential) {
        return new ReadOnlyRuntimeManagementAccess();
    }
    try {
        await readAccessChannelDevices(channelId, cancellationSignal);
        saveBrowserChannelCredential(
            channelId,
            new OwnerBrowserChannelCredential(credential.hostToken, credential.projectId),
        );
        saveProjectOwnerCredential(channelId, credential);
        return new OwnerRuntimeManagementAccess();
    } catch (error) {
        if (error instanceof PairingApiError && error.code === "owner_access_required") {
            saveBrowserChannelCredential(
                channelId,
                new LinkedBrowserChannelCredential(credential.hostToken, credential.projectId),
            );
            return new ReadOnlyRuntimeManagementAccess();
        }
        throw error;
    }
}

export async function createProjectRuntimePairing(
    channelId: string,
    projectId: string,
    idempotencyKey: string,
    cancellationSignal: AbortSignal,
): Promise<MobiusRuntimePairing> {
    const client = publicServiceClient(projectCredential(channelId, projectId));
    try {
        return await client.runtimePairings.create(
            new MobiusRuntimePairingRequest(idempotencyKey),
            requestSignal(cancellationSignal),
        );
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function readProjectRuntimePairing(
    channelId: string,
    projectId: string,
    pairingId: string,
    cancellationSignal: AbortSignal,
): Promise<MobiusRuntimePairingStatus> {
    const client = publicServiceClient(projectCredential(channelId, projectId));
    try {
        return await client.runtimePairings.read(pairingId, requestSignal(cancellationSignal));
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function readProjectRuntimes(
    channelId: string,
    projectId: string,
    cancellationSignal: AbortSignal,
): Promise<readonly MobiusRuntimeDescriptor[]> {
    const client = publicServiceClient(projectCredential(channelId, projectId));
    try {
        return await client.runtimes.list(requestSignal(cancellationSignal));
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function revokeProjectRuntime(
    channelId: string,
    projectId: string,
    runtimeId: string,
    cancellationSignal: AbortSignal,
): Promise<void> {
    const client = publicServiceClient(projectCredential(channelId, projectId));
    try {
        await client.runtimes.revoke(runtimeId, requestSignal(cancellationSignal));
    } catch (error) {
        throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

function connectionCredential(connection: ChannelConnection): BrowserChannelCredential {
    if (connection.credentialAuthority instanceof ProjectRuntimeCredentialAuthority) {
        // The Project Runtime host socket was opened with the credential the route resolved, so history
        // reads reuse that same credential rather than the selected machine's own channel file.
        return projectCredential(connection.credentialAuthority.accessChannelId, connection.projectId);
    }
    if (connection.credentialAuthority instanceof OwnerChannelCredentialAuthority) {
        return new OwnerBrowserChannelCredential(connection.hostToken, connection.projectId);
    }
    if (connection.credentialAuthority instanceof LinkedChannelCredentialAuthority) {
        return new LinkedBrowserChannelCredential(connection.hostToken, connection.projectId);
    }
    if (connection.credentialAuthority instanceof LegacyChannelCredentialAuthority) {
        return new LegacyBrowserChannelCredential(connection.hostToken, connection.projectId);
    }
    throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
}

async function readConnectionHistoryWithSignal(
    connection: ChannelConnection,
    signal: AbortSignal,
): Promise<ChannelHistory> {
    const credential = connectionCredential(connection);
    const client = publicServiceClient(credential);
    try {
        const summaries = await readConnectionDirectoryWithClient(client, connection, credential, signal);
        const results = await Promise.allSettled(
            summaries.map(async (summary) => await readSessionHistoryForSummary(client, summary, signal)),
        );
        signal.throwIfAborted();
        const restoredBySessionId = new Map<string, RestoredChannelSession>();
        for (const result of results) {
            if (result.status !== "fulfilled") {
                continue;
            }
            const restored = result.value;
            restoredBySessionId.set(restored.session.sessionId, restored);
        }
        const sessions: RecordedSession[] = [];
        const turns: RecordedTurn[] = [];
        for (const summary of summaries) {
            const restored = restoredBySessionId.get(summary.session.sessionId);
            sessions.push(restored?.session ?? summary.session);
            if (restored !== undefined) {
                turns.push(...restored.turns);
            }
        }
        return new ChannelHistory(turns, sessions);
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

async function readConnectionDirectoryWithSignal(
    connection: ChannelConnection,
    signal: AbortSignal,
): Promise<ChannelHistory> {
    const credential = connectionCredential(connection);
    const client = publicServiceClient(credential);
    try {
        const summaries = await readConnectionDirectoryWithClient(client, connection, credential, signal);
        return new ChannelHistory(
            [],
            summaries.map((summary) => summary.session),
        );
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

async function readConnectionDirectoryWithClient(
    client: MobiusClient,
    connection: ChannelConnection,
    credential: BrowserChannelCredential,
    signal: AbortSignal,
): Promise<readonly DecodedRecordedSession[]> {
    const directory = await client.sessions.list(new MobiusPageRequest(100, ""), signal);
    return directory.sessions
        .filter((session) => session.runtimeId === connection.runtimeId)
        .map((session) => decodeRecordedSession(session, credential));
}

async function readSessionHistoryWithSignal(
    connection: ChannelConnection,
    sessionId: string,
    signal: AbortSignal,
): Promise<ChannelHistory> {
    const credential = connectionCredential(connection);
    const client = publicServiceClient(credential);
    try {
        const session = decodeRecordedSession(await client.sessions.read(sessionId, signal), credential);
        if (session.session.runtimeId !== connection.runtimeId) {
            throw new PairingApiError("session_not_found", "The Session is not available in this local Runtime.");
        }
        const restored = await readSessionHistoryForSummary(client, session, signal);
        return new ChannelHistory(restored.turns, [restored.session]);
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

async function readSessionHistoryForSummary(
    client: MobiusClient,
    summary: DecodedRecordedSession,
    signal: AbortSignal,
): Promise<RestoredChannelSession> {
    const [pageResult, nativeHistoryResult, interactionsResult] = await Promise.allSettled([
        client.sessions.readMessages(summary.session.sessionId, new MobiusPageRequest(100, ""), signal),
        summary.hasNativeHistory
            ? client.sessions.readNativeHistory(summary.session.sessionId, signal)
            : Promise.resolve(null),
        client.interactions.listPending(summary.session.sessionId, signal),
    ]);
    signal.throwIfAborted();
    if (pageResult.status !== "fulfilled") {
        throw pageResult.reason;
    }
    if (nativeHistoryResult.status !== "fulfilled") {
        throw nativeHistoryResult.reason;
    }
    if (interactionsResult.status !== "fulfilled") {
        throw interactionsResult.reason;
    }
    const additionalDirectoryIds = readSessionAdditionalDirectoryIds(pageResult.value.messages);
    const turns = pageResult.value.messages.toReversed().map(decodeSessionMessage);
    const pending = pendingSessionInteractions(interactionsResult.value, summary.session.sessionId, turns);
    return {
        turns,
        session: new RecordedSession(
            summary.session.agentId,
            summary.session.bindingId,
            summary.session.configRevision,
            summary.session.directoryId,
            summary.session.runtimeId,
            summary.session.sessionId,
            summary.session.title,
            summary.session.updatedAt,
            nativeHistoryResult.value,
            pending.elicitations,
            pending.permissions,
            additionalDirectoryIds,
            pageResult.value.lastCommittedSequence,
        ),
    };
}

function decodeRecordedSession(value: MobiusSession, credential: BrowserChannelCredential): DecodedRecordedSession {
    const binding = value.defaultBinding;
    if (
        value.projectId !== credential.projectId ||
        value.state.kind !== "ready" ||
        binding.sessionId !== value.sessionId ||
        binding.agentRef !== value.agentId ||
        binding.runtimeId !== value.runtimeId
    ) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an inconsistent session summary.");
    }
    return new DecodedRecordedSession(
        value.hasNativeHistory,
        new RecordedSession(
            value.agentId,
            binding.bindingId,
            binding.configRevision,
            binding.workspaceRef,
            value.runtimeId,
            value.sessionId,
            value.title,
            value.updatedAt,
            null,
            [],
            [],
            [],
            value.lastCommittedSequence,
        ),
    );
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
        disposition: value["disposition"],
        images: value["images"],
        prompt: value["prompt"],
        resources: value["resources"],
        response: value["response"],
        sessionId: value["sessionId"],
        targetCommandId: value["targetCommandId"],
        turnId: value["turnId"],
    };
    const attempt = value["attempt"];
    if (attempt === null || (isRecord(attempt) && attempt["kind"] === "none")) {
        return decodeRecordedTurn({ ...base, status: "pending" });
    }
    if (!isRecord(attempt) || typeof attempt["kind"] !== "string") {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid execution attempt.");
    }
    const startedAt = attempt["kind"] === "dispatching" ? attempt["dispatchedAt"] : attempt["startedAt"];
    if (attempt["kind"] === "dispatching" || attempt["kind"] === "running" || attempt["kind"] === "waiting_input") {
        return decodeRecordedTurn({
            ...base,
            attemptId: attempt["attemptId"],
            startedAt,
            status: "running",
        });
    }
    if (attempt["kind"] === "succeeded") {
        return decodeRecordedTurn({
            ...base,
            attemptId: attempt["attemptId"],
            settledAt: attempt["completedAt"],
            startedAt,
            status: "completed",
            stopReason: attempt["stopReason"],
        });
    }
    if (attempt["kind"] === "cancelled") {
        return decodeRecordedTurn({
            ...base,
            attemptId: attempt["attemptId"],
            settledAt: attempt["cancelledAt"],
            startedAt,
            status: "completed",
            stopReason: "cancelled",
        });
    }
    if (attempt["kind"] === "failed") {
        return decodeRecordedTurn({
            ...base,
            code: attempt["code"],
            message: attempt["message"],
            settledAt: attempt["failedAt"],
            startedAt,
            status: "failed",
        });
    }
    if (attempt["kind"] === "indeterminate") {
        return decodeRecordedTurn({
            ...base,
            code: "indeterminate",
            message: "The runtime disconnected before the execution outcome was reconciled.",
            settledAt: attempt["detectedAt"],
            startedAt,
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
    connection: ChannelConnection,
    sessionId: string,
    attemptId: string,
    toolCallId: string,
    signal: AbortSignal,
): Promise<ActivityDetailResult> {
    const credential = connectionCredential(connection);
    const client = publicServiceClient(credential);
    try {
        return decodeActivityDetail(await client.toolCalls.readDetail(sessionId, attemptId, toolCallId, signal));
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

/**
 * The Session summary carries no running signal — `lifecycle` is only ready/deleting/deleted — so a Turn
 * in flight is visible only through that Session's own turns. Reading the active Session alone left every
 * other running Session unmarked after a reload, which is why its spinner and Stop agent disappeared.
 *
 * Hydrating every Session on every refresh would be wasteful, because refreshes also fire on a short delay
 * after each activity. The caller passes the Sessions it already has turns for, so this reads only the
 * ones still missing: the first refresh hydrates the whole directory, and later refreshes stay bounded to
 * the Sessions whose turns the caller does not already hold.
 */
export async function readChannelHistoryForSynchronization(
    connection: ChannelConnection,
    activeSessionId: string,
    hydratedSessionIds: readonly string[],
    cancellationSignal: AbortSignal,
): Promise<ChannelHistory> {
    const signal = AbortSignal.any([cancellationSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]);
    const directory = await readConnectionDirectoryWithSignal(connection, signal);
    const known = new Set(hydratedSessionIds);
    if (activeSessionId.length > 0) {
        known.delete(activeSessionId);
    }
    const sessionIds = directory.sessions
        .map((session) => session.sessionId)
        .filter((sessionId) => !known.has(sessionId));
    if (activeSessionId.length > 0 && !sessionIds.includes(activeSessionId)) {
        sessionIds.push(activeSessionId);
    }
    const results = await Promise.allSettled(
        sessionIds.map(async (sessionId) => await readSessionHistoryWithSignal(connection, sessionId, signal)),
    );
    signal.throwIfAborted();
    const turns: RecordedTurn[] = [];
    const sessionsById = new Map(directory.sessions.map((session) => [session.sessionId, session]));
    for (const result of results) {
        if (result.status !== "fulfilled") {
            continue;
        }
        const restored = result.value.sessions[0];
        if (restored !== undefined) {
            sessionsById.set(restored.sessionId, restored);
        }
        turns.push(...result.value.turns);
    }
    const ordered = directory.sessions.map((session) => sessionsById.get(session.sessionId) ?? session);
    const active = activeSessionId.length > 0 ? sessionsById.get(activeSessionId) : undefined;
    return new ChannelHistory(
        turns,
        active !== undefined && !directory.sessions.some((session) => session.sessionId === activeSessionId)
            ? [active, ...ordered]
            : ordered,
    );
}

export function pairingCommand(pairing: CreatedPairing): string {
    return `npx --yes @moxt-ai/mobius pair --url ${JSON.stringify(window.location.origin)} --pairing ${pairing.pairingId} --code ${pairing.pairingCode}`;
}
