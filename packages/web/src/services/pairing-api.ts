import {
    AGENT_ACTIVITY_DETAIL_LIMIT,
    conversationTitleFromText,
    decodeAgentDisplayContentValue,
    decodeRecordedAgentContentValue,
    decodeRecordedSessionEvent,
    decodeSessionRecordingDirectory,
    decodeSessionRecordingHistory,
    MAX_LOCAL_AGENT_DIRECTORY_ENTRIES,
    MOBIUS_API_PREFIX,
    MobiusAgentIntegrationDescriptor,
    MobiusChannelAccessClient,
    MobiusClient,
    type MobiusCredentialProvider,
    MobiusError,
    MobiusExpiredRuntimePairingStatus,
    MobiusMissingAgentDescriptor,
    MobiusPairedRuntimePairingStatus,
    MobiusPendingRuntimePairingStatus,
    type MobiusRedeemedChannelCredential,
    type MobiusRuntimeDescriptor,
    type MobiusRuntimePairing,
    MobiusRuntimePairingRequest,
    type MobiusRuntimePairingStatus,
    RUNTIME_WORKSPACE_BINDING_ID,
    type SessionElicitationRequestedEvent,
    type SessionMetadata,
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
    isToken,
    LinkedChannelCredentialAuthority,
    LinkedChannelDevice,
    MissingAgentOption,
    OwnerChannelCredentialAuthority,
    PairingApiError,
    ProjectRuntimeCredentialAuthority,
    RecordedActivity,
    RecordedContent,
    RecordedSession,
    type RecordedSessionExecution,
    type RecordedTurn,
    RunningRecordedTurn,
    StandaloneProjectRuntimeCredentialAuthority,
    type TurnTiming,
    UNAVAILABLE_RECORDED_SESSION_EXECUTION,
    WaitingBrowserPairingStatus,
} from "@/domain/channel";
import type { NativeSessionHistory } from "@/domain/native-history";

import { nativeEventHistory } from "./acp-transcript.ts";

const REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const CHANNEL_CREDENTIAL_PREFIX = "mobius:channel-credential:";
const PROJECT_OWNER_CREDENTIAL_PREFIX = "mobius:project-owner-credential:";
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

export type StandaloneRecordingConfiguration =
    | { readonly providerAvailable: boolean; readonly state: "unconfigured" }
    | { readonly enabled: boolean; readonly providerAvailable: boolean; readonly state: "configured" };

interface StandaloneProjectCredential {
    readonly projectId: string;
    readonly token: string;
}

class StandaloneProjectCredentialProvider implements MobiusCredentialProvider {
    #current: StandaloneProjectCredential | null = null;

    readonly projectCredential = async (signal: AbortSignal): Promise<StandaloneProjectCredential> => {
        if (this.#current !== null) {
            return this.#current;
        }
        const response = await fetch(new URL(`${MOBIUS_API_PREFIX}/v1/standalone/projects`, window.location.origin), {
            body: "{}",
            headers: { accept: "application/json", "content-type": "application/json" },
            method: "POST",
            signal: requestSignal(signal),
        });
        if (!response.ok) {
            let errorCode = "project_creation_failed";
            let errorMessage = "The Project creation request failed.";
            try {
                const body: unknown = await response.json();
                if (isRecord(body) && isRecord(body["error"])) {
                    if (typeof body["error"]["code"] === "string") {
                        errorCode = body["error"]["code"];
                    }
                    if (typeof body["error"]["message"] === "string") {
                        errorMessage = body["error"]["message"];
                    }
                }
            } catch {}
            throw new PairingApiError(errorCode, errorMessage);
        }
        let value: unknown;
        try {
            value = await response.json();
        } catch {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid Project credential.");
        }
        if (
            !isRecord(value) ||
            Object.keys(value).length !== 2 ||
            typeof value["projectId"] !== "string" ||
            !isIdentifier(value["projectId"]) ||
            typeof value["token"] !== "string" ||
            !isToken(value["token"])
        ) {
            throw new PairingApiError("invalid_relay_response", "The relay returned an invalid Project credential.");
        }
        const credential = Object.freeze({ projectId: value["projectId"], token: value["token"] });
        this.#current = credential;
        return credential;
    };

    readonly credential = async (signal: AbortSignal): Promise<string> => (await this.projectCredential(signal)).token;
}

let standaloneCredentialProviderState:
    | { readonly origin: string; readonly provider: StandaloneProjectCredentialProvider }
    | undefined;

export function standaloneProjectCredentialProvider(): StandaloneProjectCredentialProvider {
    const origin = window.location.origin;
    if (standaloneCredentialProviderState?.origin === origin) {
        return standaloneCredentialProviderState.provider;
    }
    const provider = new StandaloneProjectCredentialProvider();
    standaloneCredentialProviderState = { origin, provider };
    return provider;
}

export function resetStandaloneProjectCredentialProvider(): void {
    standaloneCredentialProviderState = undefined;
}

function decodeStandaloneRecordingConfiguration(value: unknown): StandaloneRecordingConfiguration {
    if (!isRecord(value) || typeof value["providerAvailable"] !== "boolean") {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid Recording configuration.");
    }
    if (value["state"] === "unconfigured" && Object.keys(value).length === 2) {
        return { providerAvailable: value["providerAvailable"], state: "unconfigured" };
    }
    if (value["state"] === "configured" && typeof value["enabled"] === "boolean" && Object.keys(value).length === 3) {
        return {
            enabled: value["enabled"],
            providerAvailable: value["providerAvailable"],
            state: "configured",
        };
    }
    throw new PairingApiError("invalid_relay_response", "The relay returned an invalid Recording configuration.");
}

async function standaloneRecordingRequest(
    method: "GET" | "PUT",
    signal: AbortSignal,
    enabled?: boolean,
): Promise<StandaloneRecordingConfiguration> {
    const provider = standaloneProjectCredentialProvider();
    const credential = await provider.projectCredential(requestSignal(signal));
    return await projectRecordingRequest(credential.projectId, credential.token, method, signal, enabled);
}

async function projectRecordingRequest(
    projectId: string,
    token: string,
    method: "GET" | "PUT",
    signal: AbortSignal,
    enabled?: boolean,
): Promise<StandaloneRecordingConfiguration> {
    const response = await fetch(
        new URL(`${MOBIUS_API_PREFIX}/v1/projects/${encodeURIComponent(projectId)}/recording`, window.location.origin),
        {
            ...(enabled === undefined ? {} : { body: JSON.stringify({ enabled }) }),
            headers: {
                authorization: `Bearer ${token}`,
                ...(enabled === undefined ? {} : { "content-type": "application/json" }),
            },
            method,
            signal: requestSignal(signal),
        },
    );
    if (!response.ok) {
        let errorCode = "recording_configuration_failed";
        let errorMessage = "The Recording configuration request failed.";
        try {
            const body: unknown = await response.json();
            if (isRecord(body) && isRecord(body["error"])) {
                if (typeof body["error"]["code"] === "string") {
                    errorCode = body["error"]["code"];
                }
                if (typeof body["error"]["message"] === "string") {
                    errorMessage = body["error"]["message"];
                }
            }
        } catch {}
        throw new PairingApiError(errorCode, errorMessage);
    }
    return decodeStandaloneRecordingConfiguration(await response.json());
}

export async function readStandaloneRecordingConfiguration(
    signal: AbortSignal,
): Promise<StandaloneRecordingConfiguration> {
    return await standaloneRecordingRequest("GET", signal);
}

export async function configureStandaloneRecording(enabled: boolean, signal: AbortSignal): Promise<void> {
    const configuration = await standaloneRecordingRequest("PUT", signal, enabled);
    if (configuration.state !== "configured" || configuration.enabled !== enabled) {
        throw new PairingApiError(
            "recording_configuration_conflict",
            "The saved Recording configuration does not match the selected choice.",
        );
    }
}

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

function readAllowedString(value: unknown, field: string, allowedValues: ReadonlySet<string>): string {
    const text = readText(value, field, 64);
    if (!allowedValues.has(text)) {
        throw new PairingApiError("invalid_relay_response", `The relay returned an invalid ${field}.`);
    }
    return text;
}

function _decodeRecordedActivity(value: unknown): RecordedActivity {
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

class ProjectOwnerBrowserCredential extends BrowserChannelCredential {
    readonly authority = "project-owner";
    readonly ownerChannelId: string;

    constructor(hostToken: string, projectId: string, ownerChannelId: string) {
        super(hostToken, projectId);
        this.ownerChannelId = ownerChannelId;
    }
}

class StandaloneProjectOwnerBrowserCredential extends BrowserChannelCredential {
    readonly authority = "standalone-project-owner";
    readonly ownerChannelId: string;

    constructor(hostToken: string, projectId: string, ownerChannelId: string) {
        super(hostToken, projectId);
        this.ownerChannelId = ownerChannelId;
    }
}

type ProjectOwnerCredential = ProjectOwnerBrowserCredential | StandaloneProjectOwnerBrowserCredential;

function isProjectOwnerCredential(credential: BrowserChannelCredential): credential is ProjectOwnerCredential {
    return (
        credential instanceof ProjectOwnerBrowserCredential ||
        credential instanceof StandaloneProjectOwnerBrowserCredential
    );
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
    if (credential instanceof StandaloneProjectOwnerBrowserCredential) {
        return new StandaloneProjectRuntimeCredentialAuthority(accessChannelId);
    }
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

function saveProjectOwnerCredential(ownerChannelId: string, credential: BrowserChannelCredential): void {
    window.localStorage.setItem(
        `${PROJECT_OWNER_CREDENTIAL_PREFIX}${credential.projectId}`,
        JSON.stringify({
            authority: credential.authority,
            hostToken: credential.hostToken,
            ownerChannelId,
            projectId: credential.projectId,
        }),
    );
}

function readProjectOwnerCredential(projectId: string): ProjectOwnerCredential {
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
    const authority = value["authority"];
    if (
        typeof hostToken !== "string" ||
        !isToken(hostToken) ||
        typeof ownerChannelId !== "string" ||
        !isIdentifier(ownerChannelId) ||
        storedProjectId !== projectId
    ) {
        throw new PairingApiError("project_owner_credential_invalid", "The saved Project owner credential is invalid.");
    }
    if (authority === "standalone-project-owner") {
        return new StandaloneProjectOwnerBrowserCredential(hostToken, projectId, ownerChannelId);
    }
    if (authority !== undefined && authority !== "project-owner" && authority !== "owner") {
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
    throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
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
    const client = publicServiceClient(credential);
    try {
        await client.channels.read(channelId, requestSignal(cancellationSignal));
        return true;
    } catch (error) {
        if (error instanceof MobiusError && error.code === "unauthorized") {
            return false;
        }
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

function requestSignal(cancellationSignal: AbortSignal): AbortSignal {
    return AbortSignal.any([cancellationSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]);
}

type ConnectionDescriptor = Pick<
    MobiusRuntimeDescriptor,
    "agents" | "channelId" | "installableAgents" | "machineName" | "projectId" | "runtimeId" | "workspaceName"
>;

function channelConnection(
    channel: ConnectionDescriptor,
    expectedChannelId: string,
    credential: BrowserChannelCredential,
): ChannelConnection {
    if (channel.channelId !== expectedChannelId) {
        throw new PairingApiError("invalid_relay_response", "The relay returned an invalid channel.");
    }
    return descriptorConnection(
        channel,
        credential,
        isProjectOwnerCredential(credential)
            ? connectionCredentialAuthority(credential, credential.ownerChannelId)
            : channelCredentialAuthority(credential),
        channel.channelId,
    );
}

function runtimeConnection(
    runtime: ConnectionDescriptor,
    credential: BrowserChannelCredential,
    accessChannelId: string,
): ChannelConnection {
    if (!isProjectOwnerCredential(credential) && !(credential instanceof LinkedBrowserChannelCredential)) {
        throw new PairingApiError(
            "runtime_access_denied",
            "This browser cannot address another Runtime in the Project.",
        );
    }
    return descriptorConnection(
        runtime,
        credential,
        connectionCredentialAuthority(credential, accessChannelId),
        accessChannelId,
    );
}

function descriptorConnection(
    runtime: ConnectionDescriptor,
    credential: BrowserChannelCredential,
    authority: ChannelCredentialAuthority,
    accessChannelId: string,
): ChannelConnection {
    if (runtime.projectId !== credential.projectId) {
        throw new PairingApiError("invalid_relay_response", "The relay returned a Runtime from another Project.");
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
        authority,
        runtime.machineName,
        runtime.workspaceName,
        credential.hostToken,
        credential.projectId,
        runtime.runtimeId,
        installableAgents,
        accessChannelId,
    );
}

export async function createBrowserPairing(signal: AbortSignal): Promise<CreatedPairing> {
    const provider = standaloneProjectCredentialProvider();
    const credential = await provider.projectCredential(requestSignal(signal));
    const client = new MobiusClient({
        credentialProvider: provider,
        endpoint: window.location.origin,
        projectId: credential.projectId,
    });
    try {
        const pairing = await client.runtimePairings.create(
            new MobiusRuntimePairingRequest(`web-${crypto.randomUUID()}`),
            requestSignal(signal),
        );
        const browserCredential = new StandaloneProjectOwnerBrowserCredential(
            credential.token,
            credential.projectId,
            pairing.channelId,
        );
        saveProjectOwnerCredential(pairing.channelId, browserCredential);
        return new CreatedPairing(
            pairing.pairingId,
            pairing.pairingCode,
            pairing.channelId,
            new Date(pairing.expiresAt),
            credential.token,
            pairing.projectId,
            pairing.runtimeId,
        );
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function readBrowserPairingStatus(
    pairing: CreatedPairing,
    cancellationSignal: AbortSignal,
): Promise<BrowserPairingStatus> {
    const credential = new StandaloneProjectOwnerBrowserCredential(
        pairing.browserToken,
        pairing.projectId,
        pairing.channelId,
    );
    const client = publicServiceClient(credential);
    try {
        const status = await client.runtimePairings.read(pairing.pairingId, requestSignal(cancellationSignal));
        if (status instanceof MobiusPendingRuntimePairingStatus) {
            return new WaitingBrowserPairingStatus(new Date(status.expiresAt));
        }
        if (status instanceof MobiusExpiredRuntimePairingStatus) {
            return new ExpiredBrowserPairingStatus();
        }
        if (status instanceof MobiusPairedRuntimePairingStatus) {
            return new ConnectedBrowserPairingStatus(runtimeConnection(status, credential, pairing.channelId));
        }
        throw new PairingApiError("runtime_pairing_revoked", "The Runtime pairing was revoked.");
    } catch (error) {
        if (error instanceof PairingApiError) {
            throw error;
        }
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function createChannelAccessGrant(
    channelId: string,
    cancellationSignal: AbortSignal,
): Promise<CreatedChannelAccessGrant> {
    const credential = readChannelCredential(channelId);
    const client = publicServiceClient(credential);
    try {
        const grant = await client.channels.createAccessGrant(channelId, requestSignal(cancellationSignal));
        return new CreatedChannelAccessGrant(grant.grantId, grant.grantSecret, new Date(grant.expiresAt));
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
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
    const client = publicServiceClient(credential);
    try {
        return (await client.channels.listLinkedDevices(channelId, requestSignal(cancellationSignal))).map(
            (device) =>
                new LinkedChannelDevice(device.credentialId, new Date(device.createdAt), new Date(device.lastUsedAt)),
        );
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
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
    let redeemed: MobiusRedeemedChannelCredential;
    try {
        redeemed = await new MobiusChannelAccessClient({ endpoint: window.location.origin }).redeem(
            channelId,
            fragment.grantId,
            fragment.grantSecret,
            requestSignal(cancellationSignal),
        );
    } catch (error) {
        return throwPublicApiFailure(error);
    }
    const credential = new LinkedBrowserChannelCredential(redeemed.hostToken, redeemed.projectId);
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
    const client = publicServiceClient(credential);
    try {
        await client.channels.revokeLinkedDevice(channelId, credentialId, requestSignal(cancellationSignal));
    } catch (error) {
        throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function readChannelConnection(
    channelId: string,
    cancellationSignal: AbortSignal = new AbortController().signal,
): Promise<ChannelConnection> {
    const credential = readChannelCredential(channelId);
    const client = publicServiceClient(credential);
    try {
        const channel = await client.channels.read(channelId, requestSignal(cancellationSignal));
        return channelConnection(channel, channelId, credential);
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

export async function readProjectRuntimeConnection(
    projectId: string,
    runtimeId: string,
    cancellationSignal: AbortSignal = new AbortController().signal,
    requestedAccessChannelId: string = "",
): Promise<ChannelConnection> {
    const credential = await resolveProjectCredential(requestedAccessChannelId, projectId, cancellationSignal);
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
    if (isProjectOwnerCredential(credential)) {
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
    signal.throwIfAborted();
    void connection;
    void sessionId;
    void artifactId;
    throw new PairingApiError(
        "artifact_unavailable",
        "This standalone Relay does not expose persisted Session artifacts.",
    );
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

async function resolveProjectCredential(
    channelId: string,
    projectId: string,
    signal: AbortSignal,
): Promise<BrowserChannelCredential> {
    signal.throwIfAborted();
    return projectCredential(channelId, projectId);
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
    const credential = await resolveProjectCredential(channelId, projectId, cancellationSignal);
    if (isProjectOwnerCredential(credential)) {
        return new OwnerRuntimeManagementAccess();
    }
    if (credential instanceof OwnerBrowserChannelCredential) {
        saveProjectOwnerCredential(channelId, credential);
        return new OwnerRuntimeManagementAccess();
    }
    if (credential instanceof LinkedBrowserChannelCredential) {
        return new ReadOnlyRuntimeManagementAccess();
    }
    throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
}

export async function createProjectRuntimePairing(
    channelId: string,
    projectId: string,
    idempotencyKey: string,
    cancellationSignal: AbortSignal,
): Promise<MobiusRuntimePairing> {
    const client = publicServiceClient(await resolveProjectCredential(channelId, projectId, cancellationSignal));
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
    const client = publicServiceClient(await resolveProjectCredential(channelId, projectId, cancellationSignal));
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
    const client = publicServiceClient(await resolveProjectCredential(channelId, projectId, cancellationSignal));
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
    const client = publicServiceClient(await resolveProjectCredential(channelId, projectId, cancellationSignal));
    try {
        await client.runtimes.revoke(runtimeId, requestSignal(cancellationSignal));
    } catch (error) {
        throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

function connectionCredential(connection: ChannelConnection): BrowserChannelCredential {
    if (connection.credentialAuthority instanceof StandaloneProjectRuntimeCredentialAuthority) {
        return new StandaloneProjectOwnerBrowserCredential(
            connection.hostToken,
            connection.projectId,
            connection.credentialAuthority.accessChannelId,
        );
    }
    if (connection.credentialAuthority instanceof ProjectRuntimeCredentialAuthority) {
        // The Project Runtime host socket was opened with the credential the route resolved, so history
        // reads reuse that same credential rather than the selected machine's own channel file.
        return new ProjectOwnerBrowserCredential(
            connection.hostToken,
            connection.projectId,
            connection.credentialAuthority.accessChannelId,
        );
    }
    if (connection.credentialAuthority instanceof OwnerChannelCredentialAuthority) {
        return new OwnerBrowserChannelCredential(connection.hostToken, connection.projectId);
    }
    if (connection.credentialAuthority instanceof LinkedChannelCredentialAuthority) {
        return new LinkedBrowserChannelCredential(connection.hostToken, connection.projectId);
    }
    throw new PairingApiError("channel_credential_invalid", "The saved channel credential is invalid.");
}

async function readConnectionRecordingConfiguration(
    connection: ChannelConnection,
    signal: AbortSignal,
): Promise<StandaloneRecordingConfiguration> {
    const credential = connectionCredential(connection);
    return await projectRecordingRequest(connection.projectId, credential.hostToken, "GET", signal);
}

async function readConnectionHistoryWithSignal(
    connection: ChannelConnection,
    signal: AbortSignal,
): Promise<ChannelHistory> {
    void connection;
    signal.throwIfAborted();
    // Standalone Runtime history is delivered by the live channel. Durable recording is owned by the
    // independent recording worker, so this Relay has no project-wide Session directory to hydrate.
    return new ChannelHistory([], []);
}

async function readConnectionDirectoryWithSignal(
    connection: ChannelConnection,
    signal: AbortSignal,
): Promise<ChannelHistory> {
    if (connection.credentialAuthority instanceof StandaloneProjectRuntimeCredentialAuthority) {
        const configuration = await readConnectionRecordingConfiguration(connection, signal);
        if (configuration.state === "configured" && configuration.enabled) {
            return await readRecordedSessionDirectory(connection, signal);
        }
    }
    const client = publicServiceClient(connectionCredential(connection));
    try {
        const entries = await client.runtimes.listSessions(connection.runtimeId, 100, signal);
        signal.throwIfAborted();
        return new ChannelHistory(
            [],
            entries
                .filter((entry) => entry.prompted)
                .map((entry) => recordedSessionFromRuntimeMetadata(connection, entry, null)),
        );
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

async function readRecordedSessionDirectory(
    connection: ChannelConnection,
    signal: AbortSignal,
): Promise<ChannelHistory> {
    const credential = connectionCredential(connection);
    const url = new URL(
        `${MOBIUS_API_PREFIX}/v1/projects/${encodeURIComponent(connection.projectId)}/recording/sessions`,
        window.location.origin,
    );
    url.searchParams.set("runtimeId", connection.runtimeId);
    const response = await fetch(url, {
        headers: { authorization: `Bearer ${credential.hostToken}` },
        signal,
    });
    if (!response.ok) {
        throw new PairingApiError("recording_directory_unavailable", "The recorded Session directory is unavailable.");
    }
    const directory = decodeSessionRecordingDirectory(await response.text());
    if (directory.sessions.some((session) => session.runtimeId !== connection.runtimeId)) {
        throw new PairingApiError("invalid_relay_response", "Recording returned a Session for another Runtime.");
    }
    return new ChannelHistory(
        [],
        directory.sessions.map(
            (summary) =>
                new RecordedSession(
                    summary.agentId,
                    RUNTIME_WORKSPACE_BINDING_ID,
                    0,
                    summary.directoryId,
                    summary.runtimeId,
                    summary.sessionId,
                    summary.title.length === 0 ? "New chat" : summary.title,
                    summary.updatedAt,
                    null,
                    UNAVAILABLE_RECORDED_SESSION_EXECUTION,
                    [],
                    [],
                    summary.additionalDirectoryIds,
                ),
        ),
    );
}

interface RecordingReplayTurn {
    readonly attemptId: string;
    readonly commandId: string;
    readonly createdAt: Date;
    readonly prompt: string;
    readonly activities: ReadonlyMap<string, RecordedActivity>;
    readonly contents: readonly RecordedContent[];
    readonly lastCommittedSequence: string;
    readonly response: string;
    readonly outcome:
        | { readonly kind: "running" }
        | { readonly kind: "completed"; readonly settledAt: Date; readonly stopReason: string }
        | { readonly code: string; readonly kind: "failed"; readonly message: string; readonly settledAt: Date };
}

function recordedActivityFromEvent(
    event: Extract<ReturnType<typeof decodeRecordedSessionEvent>, { readonly kind: "agent.activity" }>,
    attemptId: string,
): RecordedActivity {
    const detailAvailability =
        event.detail.kind === "available"
            ? "available"
            : event.detail.kind === "recorded"
              ? "inline"
              : event.detail.kind;
    return new RecordedActivity(
        event.activityId,
        attemptId,
        event.activityType,
        event.input,
        event.locations,
        event.name,
        event.output,
        event.sequence,
        event.status,
        event.title,
        event.toolKind,
        event.content,
        detailAvailability,
    );
}

async function readRecordedSessionHistory(
    connection: ChannelConnection,
    sessionId: string,
    signal: AbortSignal,
): Promise<ChannelHistory> {
    const credential = connectionCredential(connection);
    const url = new URL(
        `${MOBIUS_API_PREFIX}/v1/projects/${encodeURIComponent(connection.projectId)}/recording/sessions/${encodeURIComponent(sessionId)}/events`,
        window.location.origin,
    );
    url.searchParams.set("runtimeId", connection.runtimeId);
    const response = await fetch(url, {
        headers: { authorization: `Bearer ${credential.hostToken}` },
        signal,
    });
    if (!response.ok) {
        throw new PairingApiError("recording_history_unavailable", "The recorded Session history is unavailable.");
    }
    const history = decodeSessionRecordingHistory(await response.text());
    if (history.sessionId !== sessionId || history.segments.at(-1)?.sessionId !== sessionId) {
        throw new PairingApiError("invalid_relay_response", "Recording returned another Session's history.");
    }
    const turns = new Map<string, RecordingReplayTurn>();
    const elicitations = new Map<string, SessionElicitationRequestedEvent>();
    const permissions = new Map<string, SessionPermissionRequestedEvent>();
    let ready: Extract<ReturnType<typeof decodeRecordedSessionEvent>, { readonly kind: "session.ready" }> | null = null;
    let updatedAt = "1970-01-01T00:00:00.000Z";

    for (const segment of history.segments) {
        const targetSegment = segment.sessionId === sessionId;
        for (const entry of segment.entries) {
            signal.throwIfAborted();
            const event = decodeRecordedSessionEvent(entry.envelope.payload);
            if (event.sessionId !== segment.sessionId) {
                throw new PairingApiError("invalid_relay_response", "Recording returned an event outside its segment.");
            }
            if (targetSegment) {
                updatedAt = entry.recordedAt;
            }
            if (event.kind === "session.ready") {
                if (targetSegment) {
                    ready = event;
                }
                continue;
            }
            if (event.kind === "session.elicitation.requested") {
                if (targetSegment) {
                    elicitations.set(event.interactionId, event);
                }
                continue;
            }
            if (event.kind === "session.elicitation.resolved") {
                if (targetSegment) {
                    elicitations.delete(event.interactionId);
                }
                continue;
            }
            if (event.kind === "session.permission.requested") {
                if (targetSegment) {
                    permissions.set(event.interactionId, event);
                }
                continue;
            }
            if (event.kind === "session.permission.resolved") {
                if (targetSegment) {
                    permissions.delete(event.interactionId);
                }
                continue;
            }
            if (event.kind === "session.started") {
                const existing = turns.get(event.commandId);
                if (existing === undefined) {
                    turns.set(event.commandId, {
                        activities: new Map(),
                        attemptId: event.attemptId,
                        commandId: event.commandId,
                        contents: [],
                        createdAt: new Date(entry.recordedAt),
                        lastCommittedSequence: "0",
                        outcome: { kind: "running" },
                        prompt: event.prompt,
                        response: "",
                    });
                }
                continue;
            }
            if (!("commandId" in event)) {
                continue;
            }
            const turn = turns.get(event.commandId);
            if (turn === undefined) {
                continue;
            }
            if (event.kind === "agent.message.delta") {
                turns.set(event.commandId, {
                    ...turn,
                    lastCommittedSequence: event.sequence.toString(),
                    response: `${turn.response}${event.text}`,
                });
            } else if (event.kind === "agent.activity") {
                turns.set(event.commandId, {
                    ...turn,
                    activities: new Map(turn.activities).set(
                        event.activityId,
                        recordedActivityFromEvent(event, turn.attemptId),
                    ),
                });
            } else if (event.kind === "agent.activity.narration") {
                const activity = turn.activities.get(event.activityId);
                if (activity !== undefined) {
                    turns.set(event.commandId, {
                        ...turn,
                        activities: new Map(turn.activities).set(
                            event.activityId,
                            activity.appendingOutput(event.text),
                        ),
                    });
                }
            } else if (event.kind === "agent.content") {
                turns.set(event.commandId, {
                    ...turn,
                    contents: [
                        ...turn.contents.filter((content) => content.contentId !== event.contentId),
                        new RecordedContent(event.commandId, event.contentId, event.messageId, event.content),
                    ],
                });
            } else if (event.kind === "session.completed") {
                turns.set(event.commandId, {
                    ...turn,
                    outcome: {
                        kind: "completed",
                        settledAt: new Date(entry.recordedAt),
                        stopReason: event.stopReason,
                    },
                });
            } else if (event.kind === "session.failed") {
                turns.set(event.commandId, {
                    ...turn,
                    outcome: {
                        code: event.code,
                        kind: "failed",
                        message: event.message,
                        settledAt: new Date(entry.recordedAt),
                    },
                });
            }
        }
    }

    const agentId = ready?.agentId ?? connection.agents[0]?.id;
    if (agentId === undefined) {
        throw new PairingApiError("invalid_relay_response", "Recording does not identify the Session Agent.");
    }
    const recordedTurns: RecordedTurn[] = [];
    for (const turn of turns.values()) {
        const activities = [...turn.activities.values()].sort((left, right) => left.sequence - right.sequence);
        const timing: TurnTiming =
            turn.outcome.kind === "running"
                ? { kind: "running", startedAt: turn.createdAt }
                : {
                      elapsedMilliseconds: Math.max(0, turn.outcome.settledAt.getTime() - turn.createdAt.getTime()),
                      kind: "measured",
                  };
        if (turn.outcome.kind === "completed") {
            recordedTurns.push(
                new CompletedRecordedTurn(
                    agentId,
                    turn.commandId,
                    turn.createdAt,
                    turn.prompt,
                    turn.response,
                    sessionId,
                    turn.attemptId,
                    turn.outcome.stopReason,
                    activities,
                    [],
                    [],
                    turn.contents,
                    "reject",
                    "",
                    "",
                    timing,
                ),
            );
        } else if (turn.outcome.kind === "failed") {
            recordedTurns.push(
                new FailedRecordedTurn(
                    agentId,
                    turn.commandId,
                    turn.createdAt,
                    turn.prompt,
                    turn.response,
                    sessionId,
                    turn.outcome.code,
                    turn.outcome.message,
                    activities,
                    [],
                    [],
                    turn.contents,
                    "reject",
                    "",
                    "",
                    timing,
                ),
            );
        } else {
            recordedTurns.push(
                new RunningRecordedTurn(
                    agentId,
                    turn.commandId,
                    turn.createdAt,
                    turn.prompt,
                    turn.response,
                    sessionId,
                    turn.attemptId,
                    activities,
                    [],
                    [],
                    turn.contents,
                    "reject",
                    "",
                    "",
                    timing,
                ),
            );
        }
    }
    const firstPrompt = recordedTurns[0]?.prompt ?? "New conversation";
    const lastCommittedSeq = [...turns.values()].at(-1)?.lastCommittedSequence ?? "0";
    const session = new RecordedSession(
        agentId,
        RUNTIME_WORKSPACE_BINDING_ID,
        0,
        ready?.directoryId ?? "default",
        connection.runtimeId,
        sessionId,
        conversationTitleFromText(firstPrompt),
        updatedAt,
        null,
        UNAVAILABLE_RECORDED_SESSION_EXECUTION,
        [...elicitations.values()],
        [...permissions.values()],
        ready?.additionalDirectories.map((directory) => directory.directoryId) ?? [],
        lastCommittedSeq,
    );
    return new ChannelHistory(recordedTurns, [session]);
}

async function readSessionHistoryWithSignal(
    connection: ChannelConnection,
    sessionId: string,
    signal: AbortSignal,
): Promise<ChannelHistory> {
    if (connection.credentialAuthority instanceof StandaloneProjectRuntimeCredentialAuthority) {
        const configuration = await readConnectionRecordingConfiguration(connection, signal);
        if (configuration.state === "configured" && configuration.enabled) {
            return await readRecordedSessionHistory(connection, sessionId, signal);
        }
    }
    const credential = connectionCredential(connection);
    const client = publicServiceClient(credential);
    try {
        const entries = await client.runtimes.querySessions(connection.runtimeId, [sessionId], signal);
        signal.throwIfAborted();
        if (entries.length === 0) {
            return new ChannelHistory([], []);
        }
        const entry = entries[0];
        if (entries.length !== 1 || entry === undefined || entry.sessionId !== sessionId) {
            throw new PairingApiError("invalid_relay_response", "The Runtime returned an inconsistent Session lookup.");
        }
        const additionalDirectoryIds = entry.additionalDirectories.map((directory) => directory.directoryId);
        const identity = {
            additionalDirectoryIds,
            agentId: entry.agentId,
            directoryId: entry.directoryId,
        };
        const { execution, nativeHistory } = await readConsistentRuntimeSessionRecovery(
            client,
            connection.runtimeId,
            entry.sessionId,
            identity,
            signal,
        );
        signal.throwIfAborted();
        return new ChannelHistory(
            [],
            [recordedSessionFromRuntimeMetadata(connection, entry, nativeHistory, { ...execution, kind: "available" })],
        );
    } catch (error) {
        return throwPublicApiFailure(error);
    } finally {
        client.close();
    }
}

function sessionExecutionEpoch(
    execution: Awaited<ReturnType<MobiusClient["sessions"]["readRuntimeSessionExecution"]>>,
): string {
    return execution.turn === null ? "idle" : `${execution.turn.commandId}:${execution.turn.epoch}`;
}

async function readConsistentRuntimeSessionRecovery(
    client: MobiusClient,
    runtimeId: string,
    sessionId: string,
    identity: {
        readonly additionalDirectoryIds: readonly string[];
        readonly agentId: string;
        readonly directoryId: string;
    },
    signal: AbortSignal,
): Promise<{
    readonly execution: Awaited<ReturnType<MobiusClient["sessions"]["readRuntimeSessionExecution"]>>;
    readonly nativeHistory: NativeSessionHistory;
}> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await client.sessions.readRuntimeSessionExecution(runtimeId, sessionId, identity, signal);
        const nativeHistory = await readRuntimeNativeSessionHistory(client, runtimeId, sessionId, identity, signal);
        const after = await client.sessions.readRuntimeSessionExecution(runtimeId, sessionId, identity, signal);
        signal.throwIfAborted();
        if (sessionExecutionEpoch(before) === sessionExecutionEpoch(after)) {
            return { execution: after, nativeHistory };
        }
    }
    throw new PairingApiError(
        "session_state_changed",
        "The Session changed while its running Turn and history were being recovered.",
    );
}

function recordedSessionFromRuntimeMetadata(
    connection: ChannelConnection,
    entry: SessionMetadata,
    nativeHistory: NativeSessionHistory | null,
    execution: RecordedSessionExecution = UNAVAILABLE_RECORDED_SESSION_EXECUTION,
): RecordedSession {
    const interaction = execution.kind === "available" ? execution.turn?.interaction : null;
    return new RecordedSession(
        entry.agentId,
        RUNTIME_WORKSPACE_BINDING_ID,
        1,
        entry.directoryId,
        connection.runtimeId,
        entry.sessionId,
        entry.title,
        entry.updatedAt,
        nativeHistory,
        execution,
        interaction?.kind === "session.elicitation.requested" ? [interaction] : [],
        interaction?.kind === "session.permission.requested" ? [interaction] : [],
        entry.additionalDirectories.map((directory) => directory.directoryId),
    );
}

async function readRuntimeNativeSessionHistory(
    client: MobiusClient,
    runtimeId: string,
    sessionId: string,
    identity: {
        readonly additionalDirectoryIds: readonly string[];
        readonly agentId: string;
        readonly directoryId: string;
    },
    signal: AbortSignal,
): Promise<NativeSessionHistory> {
    const events = await client.sessions.queryRuntimeNativeEventsV2(
        runtimeId,
        sessionId,
        identity,
        { cursor: null, eventLimit: 200 },
        signal,
    );
    signal.throwIfAborted();
    return nativeEventHistory(events.events.events, events.events.truncated || events.events.nextCursor !== null);
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
