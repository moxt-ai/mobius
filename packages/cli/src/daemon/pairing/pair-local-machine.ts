import { mkdir, realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { isIdentifier, mobiusApiUrl } from "@moxt-ai/mobius-sdk/protocol";
import { fetch, type Response } from "undici";
import packageMetadata from "../../../package.json" with { type: "json" };
import { discoverLocalAgentInventory, type LocalAgentInventory } from "../../agent/discovery/discover-local-agents.ts";
import { publishAgentCatalog } from "../../runtime/catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "../../runtime/catalog/resolve-catalog-agent.ts";
import {
    type AcpAgentDefinition,
    createRuntimeConfig,
    loadDefaultWorkspace,
    OpaqueRuntimeReconnectTarget,
    type RuntimeConfig,
    RuntimeLocalContext,
} from "../../runtime/config.ts";
import {
    openRuntimeInstallationStore,
    type RuntimeInstallationStore,
    type VerifiedRuntimeConnection,
} from "../../storage/runtime-installation-store.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";
import { environmentProxyDispatcher } from "../../util/network/environment-proxy.ts";
import { prepareVersionData } from "../upgrades/data.ts";

const PAIRING_TIMEOUT_MILLISECONDS = 20_000;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const CLAIM_RESPONSE_KEYS: readonly string[] = ["appId", "channelId", "daemonToken", "runtimeId"];
const REDEEM_RESPONSE_KEYS: readonly string[] = ["appId", "channelId", "runtimeCredential", "runtimeId"];
const MOBIUS_CLI_APPLICATION_ID = "dev.mobius.cli";

interface PairCommandOptions {
    readonly code: string;
    readonly pairingId: string;
    readonly relayOrigin: URL;
    readonly workspace: string;
}

interface ClaimPairingResponse {
    readonly appId: string;
    readonly channelId: string;
    readonly runtimeCredential: string;
    readonly runtimeId: string;
}

export interface MobiusRuntimePairingOptions {
    readonly defaultWorkspace: string;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly relayOrigin: string;
}

export interface PairedRuntime {
    readonly channelUrl: string;
    readonly connectionId: string;
    readonly config: RuntimeConfig;
    readonly connectionPath: string;
}

export class PairingClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PairingClientError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function readSingleOption(arguments_: readonly string[], option: string): string {
    const values: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        if (arguments_[index] !== option) {
            continue;
        }
        const value = arguments_[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new PairingClientError("invalid_arguments", `${option} requires a value`);
        }
        values.push(value);
        index += 1;
    }
    if (values.length !== 1) {
        throw new PairingClientError("invalid_arguments", `${option} must be provided exactly once`);
    }
    return values[0] ?? "";
}

function assertKnownArguments(arguments_: readonly string[]): void {
    for (let index = 0; index < arguments_.length; index += 2) {
        const option = arguments_[index];
        if (option !== "--url" && option !== "--code" && option !== "--pairing" && option !== "--workspace") {
            throw new PairingClientError("invalid_arguments", `Unknown pairing option: ${option ?? "missing option"}`);
        }
    }
}

function parseRelayOrigin(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch (error) {
        throw new PairingClientError("invalid_relay_url", "The relay URL is invalid", { cause: error });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new PairingClientError("invalid_relay_url", "The relay URL must use http or https");
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new PairingClientError("invalid_relay_url", "The relay URL cannot contain credentials");
    }
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        throw new PairingClientError("invalid_relay_url", "A remote relay must use https");
    }
    url.hash = "";
    url.pathname = "/";
    url.search = "";
    return url;
}

function parsePairingCode(value: string): string {
    const code = value.trim().toUpperCase();
    if (!PAIRING_CODE_PATTERN.test(code)) {
        throw new PairingClientError(
            "invalid_pairing_code",
            "The pairing code must match the code shown in the browser",
        );
    }
    return code;
}

function parsePairCommand(arguments_: readonly string[], defaultWorkspace: string): PairCommandOptions {
    assertKnownArguments(arguments_);
    return {
        code: parsePairingCode(readSingleOption(arguments_, "--code")),
        pairingId: arguments_.includes("--pairing") ? validatePairingId(readSingleOption(arguments_, "--pairing")) : "",
        relayOrigin: parseRelayOrigin(readSingleOption(arguments_, "--url")),
        workspace: arguments_.includes("--workspace") ? readSingleOption(arguments_, "--workspace") : defaultWorkspace,
    };
}

function validatePairingId(value: string): string {
    if (!isIdentifier(value)) {
        throw new PairingClientError("invalid_pairing_id", "The Runtime pairing ID is invalid");
    }
    return value;
}

async function resolveDefaultWorkspace(path: string): Promise<string> {
    const requestedWorkspace = resolve(path);
    try {
        await mkdir(requestedWorkspace, { recursive: true, mode: 0o700 });
        const defaultWorkspace = await realpath(requestedWorkspace);
        const metadata = await stat(defaultWorkspace);
        if (!metadata.isDirectory()) {
            throw new PairingClientError("invalid_workspace", "The default workspace is not a directory");
        }
        return defaultWorkspace;
    } catch (error) {
        if (error instanceof PairingClientError) {
            throw error;
        }
        throw new PairingClientError("invalid_workspace", "The default workspace cannot be resolved", { cause: error });
    }
}

async function readJsonResponse(response: Response): Promise<unknown> {
    if (response.headers.get("cf-mitigated") === "challenge") {
        throw new PairingClientError(
            "relay_challenge",
            "Cloudflare is protecting this temporary preview. Claim the deployment or use an authenticated deployment, then pair again",
        );
    }
    const encoded = await response.text();
    try {
        return JSON.parse(encoded);
    } catch (error) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid response", {
            cause: error,
        });
    }
}

function readRelayError(value: unknown): PairingClientError {
    if (isRecord(value)) {
        const error = value["error"];
        if (isRecord(error)) {
            const code = error["code"];
            const message = error["message"];
            if (typeof code === "string" && typeof message === "string") {
                return new PairingClientError(code, message);
            }
        }
    }
    return new PairingClientError("pairing_failed", "The relay could not pair this machine");
}

function decodePairingResponse(
    value: unknown,
    credentialField: string,
    expectedKeys: readonly string[],
): ClaimPairingResponse {
    if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    const appId = value["appId"];
    const channelId = value["channelId"];
    const runtimeCredential = value[credentialField];
    const runtimeId = value["runtimeId"];
    if (
        typeof appId !== "string" ||
        !isIdentifier(appId) ||
        typeof channelId !== "string" ||
        !isIdentifier(channelId) ||
        typeof runtimeCredential !== "string" ||
        !TOKEN_PATTERN.test(runtimeCredential) ||
        typeof runtimeId !== "string" ||
        !isIdentifier(runtimeId)
    ) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    return { appId, channelId, runtimeCredential, runtimeId };
}

async function claimPairing(
    options: PairCommandOptions,
    defaultWorkspace: string,
    localAgents: readonly AcpAgentDefinition[],
    signal: AbortSignal,
): Promise<ClaimPairingResponse> {
    const agents = localAgents.map((agent) => ({
        agentPath: agent.agentIdentity.requestedPath,
        agentVersion: agent.agentVersion,
        agentSettingsDiscovery: true,
        capabilities: agent.capabilities,
        id: agent.id,
        label: agent.label,
        sessionTurnConfiguration: true,
    }));
    const endpoint =
        options.pairingId.length > 0
            ? mobiusApiUrl(options.relayOrigin, `/v1/runtime-pairings/${encodeURIComponent(options.pairingId)}/redeem`)
            : mobiusApiUrl(options.relayOrigin, "/pairings/claim");
    let response: Response;
    try {
        response = await fetch(endpoint, {
            body: JSON.stringify({
                agents,
                machineName: hostname(),
                pairingCode: options.code,
                workspaceName: basename(defaultWorkspace) || "Local workspace",
            }),
            dispatcher: environmentProxyDispatcher,
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(PAIRING_TIMEOUT_MILLISECONDS)]),
        });
    } catch (error) {
        throw new PairingClientError("relay_unavailable", "The pairing relay could not be reached", { cause: error });
    }

    const value = await readJsonResponse(response);
    if (!response.ok) {
        throw readRelayError(value);
    }
    return options.pairingId.length > 0
        ? decodePairingResponse(value, "runtimeCredential", REDEEM_RESPONSE_KEYS)
        : decodePairingResponse(value, "daemonToken", CLAIM_RESPONSE_KEYS);
}

function buildPairedRuntime(
    installation: RuntimeInstallationStore,
    connection: VerifiedRuntimeConnection,
    defaultWorkspace: string,
    inventory: LocalAgentInventory,
    localContext: RuntimeLocalContext,
): PairedRuntime {
    const relayUrl = mobiusApiUrl(connection.relayOrigin, "/v1/runtimes/connect");
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    relayUrl.searchParams.set("token", connection.runtimeCredential);

    const config: RuntimeConfig = createRuntimeConfig(
        {
            defaultWorkspace,
            channelId: connection.channelId,
            relayUrl,
        },
        inventory.readyAgents(),
        localContext,
        new OpaqueRuntimeReconnectTarget(connection.connectionId),
        createCatalogAgentResolver(
            (refreshSignal) =>
                discoverLocalAgentInventory({
                    defaultWorkspace,
                    environment: localContext.environment,
                    signal: refreshSignal,
                }),
            () => config,
            publishAgentCatalog,
        ),
    );
    return {
        channelUrl: new URL(`/channels/${encodeURIComponent(connection.channelId)}`, connection.relayOrigin).toString(),
        connectionId: connection.connectionId,
        config,
        connectionPath: installation.connectionPath(connection.connectionId),
    };
}

async function pairRuntime(
    installation: RuntimeInstallationStore,
    options: PairCommandOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<PairedRuntime> {
    const localContext = new RuntimeLocalContext(installation.stateDirectory, environment);
    const defaultWorkspace = await resolveDefaultWorkspace(options.workspace);
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace,
        environment: localContext.environment,
        signal,
    });
    const claim = await claimPairing(options, defaultWorkspace, inventory.readyAgents(), signal);
    const connection = await installation.saveConnection(
        {
            appId: claim.appId,
            channelId: claim.channelId,
            defaultWorkspace,
            pairingId: options.pairingId,
            relayOrigin: options.relayOrigin,
            runtimeCredential: claim.runtimeCredential,
            runtimeId: claim.runtimeId,
        },
        signal,
    );
    return buildPairedRuntime(installation, connection, defaultWorkspace, inventory, localContext);
}

export async function pairMobiusRuntime(
    installation: RuntimeInstallationStore,
    options: MobiusRuntimePairingOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<PairedRuntime> {
    return await pairRuntime(
        installation,
        {
            code: parsePairingCode(options.pairingCode),
            pairingId: validatePairingId(options.pairingId),
            relayOrigin: parseRelayOrigin(options.relayOrigin),
            workspace: options.defaultWorkspace,
        },
        signal,
        environment,
    );
}

async function resumeRuntimeConnection(
    installation: RuntimeInstallationStore,
    connection: VerifiedRuntimeConnection,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<PairedRuntime> {
    const localContext = new RuntimeLocalContext(installation.stateDirectory, environment);
    const defaultWorkspace = await resolveDefaultWorkspace(connection.defaultWorkspace);
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace,
        environment: localContext.environment,
        signal,
    });
    return buildPairedRuntime(installation, connection, defaultWorkspace, inventory, localContext);
}

export async function resumeMobiusRuntime(
    installation: RuntimeInstallationStore,
    connectionId: string,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<PairedRuntime> {
    const connection = await installation.readConnection(connectionId, signal);
    return await resumeRuntimeConnection(installation, connection, signal, environment);
}

export async function openMobiusControlInstallation(
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<RuntimeInstallationStore> {
    return await openRuntimeInstallationStore(
        {
            applicationId: MOBIUS_CLI_APPLICATION_ID,
            stateDirectory: readStateDirectory(environment),
        },
        signal,
    );
}

export async function openMobiusCliInstallation(
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<RuntimeInstallationStore> {
    await prepareVersionData(packageMetadata.version, signal, environment);
    return await openRuntimeInstallationStore(
        {
            applicationId: MOBIUS_CLI_APPLICATION_ID,
            stateDirectory: join(readStateDirectory(environment), "versions", packageMetadata.version),
        },
        signal,
    );
}

export async function pairLocalMachine(
    arguments_: readonly string[],
    signal: AbortSignal = new AbortController().signal,
): Promise<PairedRuntime> {
    const requested = parsePairCommand(arguments_, "");
    const installation = await openMobiusCliInstallation(signal, process.env);
    const localContext = new RuntimeLocalContext(installation.stateDirectory, process.env);
    if (requested.pairingId.length > 0) {
        const existing = await installation.readConnectionForPairing(requested.pairingId, signal);
        if (existing !== null) {
            return await resumeRuntimeConnection(installation, existing, signal, process.env);
        }
    }
    return await pairRuntime(
        installation,
        {
            code: requested.code,
            pairingId: requested.pairingId,
            relayOrigin: requested.relayOrigin,
            workspace: arguments_.includes("--workspace")
                ? requested.workspace
                : loadDefaultWorkspace(localContext.environment),
        },
        signal,
        process.env,
    );
}
