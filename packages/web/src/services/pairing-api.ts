import {
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
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";

import {
    AgentIntegrationOption,
    AgentOption,
    type BrowserPairingStatus,
    ChannelConnection,
    type ChannelCredentialAuthority,
    ConnectedBrowserPairingStatus,
    CreatedChannelAccessGrant,
    CreatedPairing,
    ExpiredBrowserPairingStatus,
    type InstallableAgentOption,
    isIdentifier,
    isToken,
    LinkedChannelCredentialAuthority,
    LinkedChannelDevice,
    MissingAgentOption,
    OwnerChannelCredentialAuthority,
    PairingApiError,
    ProjectRuntimeCredentialAuthority,
    StandaloneProjectRuntimeCredentialAuthority,
    WaitingBrowserPairingStatus,
} from "@/domain/channel";

const REQUEST_TIMEOUT_MILLISECONDS = 20_000;

const CHANNEL_CREDENTIAL_PREFIX = "mobius:channel-credential:";

const PROJECT_OWNER_CREDENTIAL_PREFIX = "mobius:project-owner-credential:";

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
        (agent) => new AgentOption(agent.id, agent.label, agent.agentPath, agent.agentVersion),
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

export function pairingCommand(pairing: CreatedPairing): string {
    return `npx --yes @moxt-ai/mobius pair --url ${JSON.stringify(window.location.origin)} --pairing ${pairing.pairingId} --code ${pairing.pairingCode}`;
}
